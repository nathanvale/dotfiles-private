import { expect, test } from "bun:test";
import { join } from "node:path";
import { Config } from "../../src/command-contract.ts";

test("the shipped example names the current pilot with start disabled and is valid configuration", async () => {
  const example = await Bun.file(join(import.meta.dir, "../../examples/targets.json")).json();
  const parsed = Config.safeParse(example);
  expect(parsed.success).toBe(true);
  // Independent literal oracle: the assigned pilot's identity as supplied by the foreground owner.
  expect(parsed.data?.targets).toEqual([
    {
      allowStart: false,
      container: "agents-pilot",
      containerId: "568ba4e66e3b13c188cb206f480b2b81310b8275ae7a355280ce250cf3b69e0e",
      guide: "/workspace/START-HERE.md",
      host: "mini",
      id: "pilot",
      label: "Agents pilot",
      role: "ui-pilot",
      serviceLog: "/home/agent/.local/state/pilot-runtime/restore-intake-20261114-01/service.log",
      workspaceFolder: "/workspace",
    },
  ]);
  expect(parsed.data?.editor).toEqual({
    extensionsDir: "~/.local/state/remote-devcontainer-isolation/trial-01/extensions",
    userDataDir: "~/.local/state/remote-devcontainer-isolation/trial-01/user-data",
  });
  expect(parsed.data?.hosts.map((host) => `${host.id}|${host.sshAlias}|${host.dockerHost}`)).toEqual([
    "mini|mac-mini|unix:///Users/server/.orbstack/run/docker.sock",
  ]);
});

test("the in-container guide names the current pilot, its service log, and the readiness limits", async () => {
  const guide = await Bun.file(join(import.meta.dir, "../../guide/START-HERE.md")).text();
  expect(guide).toContain("**agents-pilot** on the Mini's ARM64 OrbStack");
  expect(guide).toContain("(../home/agent/.local/state/pilot-runtime/restore-intake-20261114-01/service.log)");
  expect(guide).toContain("/workspace/dotfiles");
  expect(guide).toContain("A connected editor does not prove that a repository, service or agent is ready.");
  expect(guide).toContain("with credentials redacted.");
  expect(guide).toContain("Docker starts this container with `sleep infinity`");
  expect(guide).toContain("then restores Core, Tailscale and Shepherdr through the configured native route.");
  expect(guide).toContain("holds remain unchanged.");
  expect(guide).not.toContain("shepherdr-pilot-main-20261112");
  expect(guide).not.toContain("main-d57a0261");
  expect(guide).not.toContain("No engineering repository has been set up");
});
