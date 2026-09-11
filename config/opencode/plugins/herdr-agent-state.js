// installed by herdr
// managed by herdr; reinstalling or updating the integration overwrites this file.
// add custom hooks/plugins beside this file instead of editing it.
// HERDR_INTEGRATION_ID=opencode
// HERDR_INTEGRATION_VERSION=11

import net from "node:net";

const SOURCE = "herdr:opencode";
const AGENT = "opencode";
let reportSeq = Date.now() * 1000;
let requestChain = Promise.resolve();
let reportedRootSessionID;

// Track child sessions so their events cannot replace the pane's root session.
// User prompts carry the root id to preserve its identity and cross-talk guard.
const childSessions = new Map();
const CHILD_EVENT_STATES = new Map([
  ["permission.asked", "blocked"],
  ["question.asked", "blocked"],
  ["permission.replied", "working"],
  ["question.replied", "working"],
  ["question.rejected", "working"],
]);
const EVENT_STATE_BY_TYPE = new Map([
  ["tool.execute.before", "working"],
  ["tool.execute.after", "working"],
  ["permission.replied", "working"],
  ["question.replied", "working"],
  ["question.rejected", "working"],
  ["session.compacted", "working"],
  ["permission.asked", "blocked"],
  ["question.asked", "blocked"],
  ["session.error", "blocked"],
  ["session.idle", "idle"],
]);

function nextReportSeq() {
  reportSeq += 1;
  return reportSeq;
}

function sessionIDFromProperties(properties) {
  return typeof properties?.sessionID === "string" && properties.sessionID
    ? properties.sessionID
    : undefined;
}

const SESSION_STATE_BY_STATUS = new Map([
  ["idle", "idle"],
  ["active", "working"],
  ["busy", "working"],
  ["pending", "working"],
  ["retry", "working"],
  ["running", "working"],
  ["streaming", "working"],
  ["working", "working"],
]);

function stateFromSessionStatus(status) {
  const kind = typeof status === "string" ? status : status?.type;
  return typeof kind === "string"
    ? SESSION_STATE_BY_STATUS.get(kind.toLowerCase())
    : undefined;
}

function rememberChildSession(properties) {
  const info = properties.info;
  if (info?.id && info.parentID) {
    childSessions.set(info.id, info.parentID);
  }
}

function rootSessionIDFor(sessionID) {
  if (!sessionID || !childSessions.has(sessionID)) {
    return undefined;
  }

  let rootSessionID = sessionID;
  while (childSessions.has(rootSessionID)) {
    rootSessionID = childSessions.get(rootSessionID);
  }
  return rootSessionID;
}

async function handleChildEvent(type, sessionID) {
  const rootSessionID = rootSessionIDFor(sessionID);
  if (!rootSessionID) {
    return false;
  }

  const state = CHILD_EVENT_STATES.get(type);
  if (state) {
    await reportState(state, rootSessionID);
  }
  return true;
}

async function handleSessionEvent(type, properties, sessionID) {
  if (type === "session.created") {
    // Creation is server-global, so an attached client may own it. The
    // TUI plugin separately reports the root selected in this pane.
    reportedRootSessionID = sessionID;
    return;
  }

  if (type === "session.updated") {
    if (!sessionID || sessionID === reportedRootSessionID) {
      return;
    }
    await reportSession(sessionID);
    return;
  }

  if (type === "session.status") {
    const state = stateFromSessionStatus(properties.status);
    if (state) {
      await reportState(state, sessionID);
      return;
    }
    await reportSession(sessionID);
    return;
  }

  const state = EVENT_STATE_BY_TYPE.get(type);
  if (state) {
    await reportState(state, sessionID);
  }
}

function request(method, params) {
  const pending = requestChain.then(() => requestOnce(method, params));
  requestChain = pending.catch(() => {});
  return pending;
}

function requestOnce(method, params) {
  const paneId = process.env.HERDR_PANE_ID;
  const socketPath = process.env.HERDR_SOCKET_PATH;

  if (!paneId || !socketPath) {
    return Promise.resolve();
  }

  const socketEndpoint =
    process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;

  const requestId = `${SOURCE}:${Date.now()}:${Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, "0")}`;
  const request = {
    id: requestId,
    method,
    params: {
      pane_id: paneId,
      source: SOURCE,
      agent: AGENT,
      seq: nextReportSeq(),
      ...params,
    },
  };

  return new Promise((resolve) => {
    const client = net.createConnection(socketEndpoint, () => {
      client.write(`${JSON.stringify(request)}\n`);
    });

    const finish = () => {
      client.destroy();
      resolve();
    };

    client.setTimeout(500, finish);
    client.on("data", finish);
    client.on("error", finish);
    client.on("end", finish);
    client.on("close", resolve);
  });
}

function reportSession(sessionID) {
  if (!sessionID) {
    return Promise.resolve();
  }
  return request("pane.report_agent_session", { agent_session_id: sessionID });
}

function reportState(state, sessionID) {
  const params = { state };
  if (sessionID) {
    reportedRootSessionID = sessionID;
    params.agent_session_id = sessionID;
  }
  return request("pane.report_agent", params);
}

export const HerdrAgentStatePlugin = async () => {
  if (
    process.env.HERDR_ENV !== "1" ||
    !process.env.HERDR_SOCKET_PATH ||
    !process.env.HERDR_PANE_ID
  ) {
    return {};
  }

  return {
    "chat.message": async ({ sessionID }) => {
      if (sessionID && childSessions.has(sessionID)) {
        return;
      }
      await reportState("working", sessionID);
    },
    event: async ({ event }) => {
      const type = event?.type;
      const properties = event?.properties ?? {};
      const sessionID = sessionIDFromProperties(properties);

      rememberChildSession(properties);
      if (await handleChildEvent(type, sessionID)) {
        return;
      }

      await handleSessionEvent(type, properties, sessionID);
    },
  };
};
