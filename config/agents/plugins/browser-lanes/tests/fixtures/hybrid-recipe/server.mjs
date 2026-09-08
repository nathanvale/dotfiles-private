import { createServer } from 'node:http';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const usage = 'usage: node server.mjs --state ABSOLUTE_PATH [--port PORT] [--origin-file ABSOLUTE_PATH]';

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function requiredAbsolutePath(name) {
  const value = option(name);
  if (!value || !value.startsWith('/')) throw new TypeError(`${name} must be an absolute path`);
  return resolve(value);
}

function parsePort() {
  const value = option('--port') ?? '0';
  if (!/^(0|[1-9][0-9]{0,4})$/.test(value)) throw new TypeError('--port must be an integer from 0 through 65535');
  const port = Number(value);
  if (port > 65535) throw new TypeError('--port must be an integer from 0 through 65535');
  return port;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

function initialState() {
  return { version: 1, nextDraftId: 0, saves: 0, submissions: 0, draft: null };
}

function validState(value) {
  return value
    && value.version === 1
    && Number.isInteger(value.nextDraftId)
    && Number.isInteger(value.saves)
    && value.submissions === 0
    && (value.draft === null || (
      Number.isInteger(value.draft.id)
      && typeof value.draft.title === 'string'
      && value.draft.status === 'Draft'
    ));
}

function readState(statePath) {
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    if (!validState(state)) throw new TypeError('state has an invalid shape');
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return initialState();
    throw error;
  }
}

function writeState(statePath, state) {
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, statePath);
}

function shell(content, state) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Hybrid recipe fixture</title><style>body{font:18px system-ui;margin:40px;max-width:760px}input,button{font:inherit;margin:.5rem 0;padding:.5rem}label{display:block}td,th{padding:.5rem;text-align:left}</style></head><body><h1>Hybrid recipe fixture</h1><p>Local only. This fixture has no submission operation.</p><nav><a href="/week">Week overview</a></nav>${content}<footer><p>Save count: ${state.saves}. Submissions: ${state.submissions}.</p></footer></body></html>`;
}

function respondHtml(response, state, content, status = 200) {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(shell(content, state));
}

function redirect(response, location) {
  response.writeHead(303, { location, 'cache-control': 'no-store' });
  response.end();
}

async function readForm(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 4096) throw new RangeError('input too large');
  }
  return new URLSearchParams(body);
}

function overview(state) {
  if (!state.draft) {
    return '<h2>Week overview</h2><p id="baseline">No saved drafts. Status: Initial.</p><a href="/new">Prepare draft</a>';
  }
  const draft = state.draft;
  return `<h2>Week overview</h2><p id="saved-summary">One saved draft. Status: Draft.</p><table><thead><tr><th>Title</th><th>Status</th></tr></thead><tbody><tr><td><a href="/draft/${draft.id}">${escapeHtml(draft.title)}</a></td><td>Draft</td></tr></tbody></table><p>Reopen the saved draft to verify it.</p>`;
}

function newDraft() {
  return '<h2>New draft</h2><form method="post" action="/save"><label for="draft-title">Draft title</label><input id="draft-title" name="draft-title" required><button type="submit" data-action="save-draft">Save draft</button></form>';
}

function savedDraft(draft) {
  return `<h2>Saved draft</h2><p>Status: <strong>Draft</strong></p><label for="draft-title">Draft title</label><input id="draft-title" name="draft-title" value="${escapeHtml(draft.title)}" readonly><p><a href="/week">Return to overview</a></p>`;
}

function fixtureServer(statePath) {
  return createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    let state;
    try {
      state = readState(statePath);
    } catch (error) {
      respondHtml(response, initialState(), `<p role="alert">Fixture state is unreadable: ${escapeHtml(error.message)}</p>`, 500);
      return;
    }

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/week')) {
      respondHtml(response, state, overview(state));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/new') {
      respondHtml(response, state, newDraft());
      return;
    }
    if (request.method === 'GET' && state.draft && url.pathname === `/draft/${state.draft.id}`) {
      respondHtml(response, state, savedDraft(state.draft));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/save') {
      if (state.draft) {
        respondHtml(response, state, '<p role="alert">A draft is already saved. Inspect it before any further action.</p>', 409);
        return;
      }
      try {
        const fields = await readForm(request);
        const title = fields.get('draft-title')?.trim();
        if (!title) {
          respondHtml(response, state, '<p role="alert">Draft title is required.</p>', 400);
          return;
        }
        const next = {
          ...state,
          nextDraftId: state.nextDraftId + 1,
          saves: state.saves + 1,
          draft: { id: state.nextDraftId + 1, title, status: 'Draft' },
        };
        writeState(statePath, next);
        redirect(response, `/week?saved=${next.draft.id}`);
      } catch (error) {
        const status = error instanceof RangeError ? 413 : 500;
        respondHtml(response, state, `<p role="alert">Save did not complete: ${escapeHtml(error.message)}</p>`, status);
      }
      return;
    }
    if (url.pathname === '/submit') {
      respondHtml(response, state, '<p role="alert">Submission is unavailable in this fixture.</p>', 405);
      return;
    }
    respondHtml(response, state, '<p>Page not found.</p>', 404);
  });
}

function main() {
  try {
    const statePath = requiredAbsolutePath('--state');
    const port = parsePort();
    const originFile = option('--origin-file');
    if (originFile && !originFile.startsWith('/')) throw new TypeError('--origin-file must be an absolute path');
    const server = fixtureServer(statePath);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const origin = `http://127.0.0.1:${address.port}`;
      if (originFile) writeFileSync(resolve(originFile), `${origin}\n`, { mode: 0o600 });
      process.stdout.write(`${origin}/week\n`);
    });
  } catch (error) {
    process.stderr.write(`${usage}\n${error.message}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

export { fixtureServer, initialState, readState };
