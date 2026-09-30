// Public front door: frozen legacy goldens for check, list and inventory, and the Contract Core 2.0 control paths
// (help, discovery, refusal). Every expected value below is a test-owned literal, never read back from src/.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dir, "..", "src", "main.ts");
const BIN = path.join(import.meta.dir, "..", "..", "..", "bin", "vault-notes");
const CONTRACT = path.join(import.meta.dir, "fixtures", "frontmatter-contract.json");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const frontmatter = (fields: string) => `---\n${fields}\n---\n\n# Fixture\n`;
const SAM = frontmatter(
  'title: "Sam"\ntype: person\nstatus: active\nupdated: 2026-08-06\nsummary: "A fixture person."\nperson_id: person_sam\nslug: sam\nrelationship_type: friend\naliases:\n  - Sammy',
);
const BROKEN = `${frontmatter('title: "Broken"\ntype: reference\nstatus: active\nupdated: yesterday\nsummary: "Broken fixture."')}\n[Missing](missing.md)\n`;

/** A small valid vault: root README, the people family index and one person. */
async function vault(extra: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vault-notes-cli-"));
  roots.push(root);
  const files: Record<string, string> = {
    "README.md": frontmatter('title: "Fixture Vault"\ntype: vault-index\nstatus: active\nupdated: 2026-08-06\nsummary: "Fixture root."'),
    "people/README.md": frontmatter('title: "People"\ntype: family-index\nstatus: active\nupdated: 2026-08-06\nsummary: "People route."'),
    "people/sam.md": SAM,
    ...extra,
  };
  await mkdir(path.join(root, "schemas"));
  await writeFile(path.join(root, "schemas", "frontmatter-contract.json"), await Bun.file(CONTRACT).text());
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return root;
}

/** Runs the front door with no canonical-root configuration, so only --root selects the vault. */
function run(args: string[], entry: string[] = [process.execPath, CLI]) {
  const home = path.join(tmpdir(), "vault-notes-cli-no-home");
  const result = Bun.spawnSync([...entry, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: path.join(home, "xdg") },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exit: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

const LIST_USAGE = `List current vault notes from their metadata. This command writes nothing.

Usage: bun run list [--family <name>] [--root <path>] [--json]

Examples:
  bun run list --family products
  bun run list --family projects --json

Family indexes are navigation, not a complete catalog. New notes appear here
without an index edit. Paths are relative to the selected vault root.
`;

describe("legacy check golden output", () => {
  test("a clean vault passes on stdout only; unknown arguments, including --help, are ignored", async () => {
    const root = await vault();
    for (const extra of [[], ["--help"], ["--unknown"]]) {
      expect(run(["check", "--root", root, ...extra])).toEqual({ exit: 0, stdout: "Vault check passed.\n", stderr: "" });
    }
    expect(run(["check", "--root", root, "--json"])).toEqual({ exit: 0, stdout: '{"schema_version":1,"findings":[]}\n', stderr: "" });
  });

  test("findings go to stderr in human mode and to stdout in --json mode, both exiting 1", async () => {
    const root = await vault({ "people/broken.md": BROKEN });
    expect(run(["check", "--root", root])).toEqual({
      exit: 1,
      stdout: "",
      stderr: [
        "people/broken.md: change type to 'person' for this path",
        "people/broken.md: format 'updated' as YYYY-MM-DD",
        "people/broken.md: repair missing local link 'missing.md'",
        "",
        "3 issues found.",
        "",
      ].join("\n"),
    });
    expect(run(["check", "--root", root, "--json"])).toEqual({
      exit: 1,
      stdout:
        '{"schema_version":1,"findings":[' +
        '{"id":"type-path-mismatch","file":"people/broken.md","message":"change type to \'person\' for this path","repair_id":null},' +
        '{"id":"field-shape-invalid","file":"people/broken.md","message":"format \'updated\' as YYYY-MM-DD","repair_id":null,"detail":{"field":"updated"}},' +
        '{"id":"link-missing-target","file":"people/broken.md","message":"repair missing local link \'missing.md\'","repair_id":null}]}\n',
      stderr: "",
    });
  });

  test("a single finding uses the singular summary line", async () => {
    const root = await vault({ "people/lost.md": `${SAM.replace("person_sam", "person_lost").replace("slug: sam", "slug: lost")}\n[Gone](gone.md)\n` });
    expect(run(["check", "--root", root])).toEqual({
      exit: 1,
      stdout: "",
      stderr: "people/lost.md: repair missing local link 'gone.md'\n\n1 issue found.\n",
    });
  });

  test("an unreadable contract ends with the uncaught runtime error and no result", async () => {
    const root = await vault();
    await rm(path.join(root, "schemas"), { recursive: true });
    const result = run(["check", "--root", root, "--json"]);
    expect(result.exit).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ENOENT");
  });
});

describe("legacy list golden output", () => {
  test("human listing, --json listing and the legacy help text", async () => {
    const root = await vault();
    expect(run(["list", "--root", root, "--family", "people"])).toEqual({
      exit: 0,
      stdout: "people/sam.md\n  Sam (person, active)\n  A fixture person.\n",
      stderr: "",
    });
    expect(run(["list", "--root", root, "--family", "people", "--json"])).toEqual({
      exit: 0,
      stdout: '{"schemaVersion":1,"ok":true,"notes":[{"path":"people/sam.md","title":"Sam","type":"person","status":"active","summary":"A fixture person."}]}\n',
      stderr: "",
    });
    expect(run(["list", "--root", root, "--family", "products"])).toEqual({ exit: 0, stdout: "No notes found.\n", stderr: "" });
    for (const flag of ["--help", "-h"]) {
      expect(run(["list", "--root", root, flag])).toEqual({ exit: 0, stdout: LIST_USAGE, stderr: "" });
    }
  });

  test("refusals: human text on stderr, --json object on stdout, exit 1", async () => {
    const root = await vault({ "people/bare.md": "# No metadata\n" });
    expect(run(["list", "--root", root, "--unknown"])).toEqual({
      exit: 1,
      stdout: "",
      stderr: "INVALID_USAGE: Run bun run list --help for supported arguments.\n",
    });
    expect(run(["list", "--root", root, "--family", "people"])).toEqual({
      exit: 1,
      stdout: "",
      stderr: "INVALID_NOTES: Run bun run check and repair the named files before relying on a complete listing.\npeople/bare.md\n",
    });
    expect(run(["list", "--root", path.join(root, "absent"), "--json"])).toEqual({
      exit: 1,
      stdout:
        '{"schemaVersion":1,"ok":false,"code":"LIST_FAILED","nextAction":"Confirm the vault root is readable and contains schemas/frontmatter-contract.json, then run bun run check.","files":[]}\n',
      stderr: "",
    });
  });
});

describe("legacy inventory golden output", () => {
  test("human and pretty-printed --json counts", async () => {
    const root = await vault();
    expect(run(["inventory", "--root", root])).toEqual({
      exit: 0,
      stdout: [
        "Vault notes: 3",
        "",
        "By family",
        "  people: 2",
        "  root: 1",
        "",
        "By type",
        "  family-index: 1",
        "  person: 1",
        "  vault-index: 1",
        "",
        "By status",
        "  active: 3",
        "",
      ].join("\n"),
      stderr: "",
    });
    expect(run(["inventory", "--root", root, "--json"])).toEqual({
      exit: 0,
      stdout:
        '{\n  "total": 3,\n  "byFamily": {\n    "root": 1,\n    "people": 2\n  },\n  "byType": {\n    "vault-index": 1,\n    "family-index": 1,\n    "person": 1\n  },\n  "byStatus": {\n    "active": 3\n  }\n}\n',
      stderr: "",
    });
  });
});

describe("Contract Core 2.0 control paths", () => {
  const CONTROL_IDENTITIES = [
    "vault-notes.check",
    "vault-notes.command-discovery",
    "vault-notes.discovery",
    "vault-notes.help",
    "vault-notes.inventory",
    "vault-notes.list",
    "vault-notes.resources",
  ];

  function envelope(args: string[]) {
    const result = run(args);
    expect(result.stderr).toBe("");
    expect(result.stdout.endsWith("}\n")).toBe(true);
    return { exit: result.exit, body: JSON.parse(result.stdout) };
  }

  test("human help names every command, option and example on stdout", () => {
    const result = run(["--help"]);
    expect(result.exit).toBe(0);
    expect(result.stderr).toBe("");
    for (const line of [
      "  vault-notes check [--root PATH] [--canonical-root PATH] [--json]",
      "  vault-notes list [--family NAME] [--root PATH] [--json] [--help]",
      "  vault-notes inventory [--root PATH] [--json]",
      "  vault-notes resources [--project SLUG]... [--root PATH] [--updated YYYY-MM-DD] [--json]",
      "  vault-notes --help [--json] | --discover [--json] | --discover-command COMMAND_IDENTITY [--json]",
      "  vault-notes --discover-command vault-notes.check --json",
    ]) {
      expect(result.stdout).toContain(`${line}\n`);
    }
    expect(run(["-h"]).stdout).toBe(result.stdout);
  });

  test("machine help and discovery are success envelopes with an inspect-only, unchanged, empty effect inventory", () => {
    for (const [args, identity] of [
      [["--help", "--json"], "vault-notes.help"],
      [["--discover", "--json"], "vault-notes.discovery"],
      [["--discover-command", "vault-notes.list", "--json"], "vault-notes.command-discovery"],
    ] as const) {
      const { exit, body } = envelope([...args]);
      expect(exit).toBe(0);
      expect(body).toMatchObject({ envelopeVersion: 2, contractVersion: "2.0.0", availablePaths: CONTROL_IDENTITIES });
      expect(body.result).toMatchObject({
        commandIdentity: identity,
        outcome: "success",
        effectClass: "inspect",
        transactionState: "unchanged",
        causeCode: "SUCCESS_UNCHANGED",
        failureClass: null,
        exitCode: 0,
        retryable: false,
        repairAction: null,
        effects: { completed: [], inventoryComplete: true, remaining: [], uncertain: [] },
      });
      expect(body.result.nextAction.length).toBeGreaterThan(0);
    }
  });

  test("discovery reports the simple profile and every command as inspect-only", () => {
    const { body } = envelope(["--discover", "--json"]);
    const data = body.result.data;
    expect(data.profile).toBe("simple");
    expect(data.commands.map((command: { commandIdentity: string }) => command.commandIdentity)).toEqual([
      "vault-notes.dispatch",
      "vault-notes.help",
      "vault-notes.discovery",
      "vault-notes.command-discovery",
      "vault-notes.check",
      "vault-notes.list",
      "vault-notes.inventory",
      "vault-notes.resources",
    ]);
    expect(new Set(data.commands.map((command: { effectClass: string }) => command.effectClass))).toEqual(new Set(["inspect"]));
    expect(data.effectExclusions.length).toBe(3);
  });

  test("discovery data and every command summary carry exactly the Contract Core 2.0 keys", () => {
    const { data } = envelope(["--discover", "--json"]).body.result;
    expect(Object.keys(data).sort()).toEqual([
      "commands",
      "contractVersion",
      "effectExclusions",
      "exitMeanings",
      "generationConventionVersion",
      "profile",
      "signalExits",
    ]);
    for (const command of data.commands) {
      expect(Object.keys(command).sort()).toEqual(["commandIdentity", "effectClass", "route", "summary"]);
    }
  });

  test("command discovery carries the legacy output contract with exact keys", () => {
    for (const identity of ["vault-notes.check", "vault-notes.list", "vault-notes.inventory"]) {
      const { data } = envelope(["--discover-command", identity, "--json"]).body.result;
      const keys = ["command", "outcomes", "outputContract", "semantics"];
      expect(Object.keys(data).sort()).toEqual(identity === "vault-notes.check" ? ["command", "findingIds", "outcomes", "outputContract", "semantics"] : keys);
      expect(data.semantics).toBe("possible-outcomes");
      expect(data.command.commandIdentity).toBe(identity);
      expect(data.outputContract).toEqual({
        kind: "legacy",
        envelope: false,
        exitMeanings: { "0": "success", "1": "findings, refusal or failure; read the outcomes" },
      });
      for (const outcome of data.outcomes) {
        expect(Object.keys(outcome).sort()).toEqual(["exitCode", "human", "id", "machine", "trigger"]);
      }
    }
  });

  test("check discovery lists the nineteen legacy and eight resources finding identifiers", () => {
    const { body } = envelope(["--discover-command", "vault-notes.check", "--json"]);
    expect(body.result.data.findingIds).toEqual([
      "frontmatter-invalid-yaml",
      "frontmatter-missing",
      "required-field-missing",
      "type-required-field-missing",
      "type-unknown",
      "status-invalid",
      "path-unrouted",
      "type-path-mismatch",
      "optional-field-empty",
      "forbidden-field-present",
      "field-shape-invalid",
      "summary-too-long",
      "body-secret-shaped-value",
      "identity-duplicate",
      "link-missing-target",
      "filename-uppercase",
      "ticket-placement-invalid",
      "ticket-spec-invalid",
      "artifact-map-missing",
      "resources-contract-invalid",
      "resources-route-missing",
      "resources-index-missing",
      "resources-block-invalid",
      "resources-entry-missing",
      "resources-entry-stale",
      "resources-entry-foreign",
      "resources-entry-duplicate",
    ]);
  });

  test("every declared legacy outcome is reached with its declared exit, and no undeclared outcome exists", async () => {
    const clean = await vault();
    const broken = await vault({ "people/broken.md": BROKEN });
    const bare = await vault({ "people/bare.md": "# No metadata\n" });
    const absent = path.join(clean, "absent");
    const scenarios: Record<string, { args: string[]; exit: number }> = {
      "check.passed": { args: ["check", "--root", clean], exit: 0 },
      "check.findings": { args: ["check", "--root", broken], exit: 1 },
      "check.unreadable": { args: ["check", "--root", absent], exit: 1 },
      "list.listed": { args: ["list", "--root", clean], exit: 0 },
      "list.help": { args: ["list", "--help"], exit: 0 },
      "list.invalid-usage": { args: ["list", "--root", clean, "--family", "elsewhere"], exit: 1 },
      "list.invalid-notes": { args: ["list", "--root", bare], exit: 1 },
      "list.failed": { args: ["list", "--root", absent], exit: 1 },
      "inventory.counted": { args: ["inventory", "--root", clean], exit: 0 },
      "inventory.unreadable": { args: ["inventory", "--root", absent], exit: 1 },
    };
    const declared: { id: string; exitCode: number }[] = [];
    for (const identity of ["vault-notes.check", "vault-notes.list", "vault-notes.inventory"]) {
      declared.push(...envelope(["--discover-command", identity, "--json"]).body.result.data.outcomes);
    }
    expect(declared.map((outcome) => outcome.id)).toEqual(Object.keys(scenarios));
    for (const outcome of declared) {
      const scenario = scenarios[outcome.id] as { args: string[]; exit: number };
      expect([outcome.id, outcome.exitCode]).toEqual([outcome.id, scenario.exit]);
      expect([outcome.id, run(scenario.args).exit]).toEqual([outcome.id, scenario.exit]);
    }
  });

  test("missing, unknown and malformed selections refuse with exit 2 and never run a command", () => {
    for (const args of [[], ["frobnicate"], ["--discover", "--help"], ["--discover-command"], ["--discover-command", "vault-notes.help"], ["--root", "."]]) {
      const human = run(args);
      expect(human.exit).toBe(2);
      expect(human.stdout).toBe("");
      expect(human.stderr).toEndWith(
        "Repair: Choose check, list, inventory, resources, --help, --discover or --discover-command COMMAND_IDENTITY with its listed options and retry.\n",
      );
      const { exit, body } = envelope([...args, "--json"]);
      expect(exit).toBe(2);
      expect(body.result).toMatchObject({
        outcome: "refused",
        causeCode: "USAGE_INVALID_INVOCATION",
        failureClass: "usage",
        exitCode: 2,
        transactionState: "unchanged",
        data: null,
        retryable: false,
        nextAction: "Run vault-notes --help and choose a listed command.",
      });
    }
    expect(run([]).stderr).toBe(
      "Choose a command. Repair: Choose check, list, inventory, resources, --help, --discover or --discover-command COMMAND_IDENTITY with its listed options and retry.\n",
    );
  });

  test("held-open non-TTY stdin never blocks a command or a control path", async () => {
    const root = await vault();
    for (const args of [["check", "--root", root], ["--help"]]) {
      const child = Bun.spawn([process.execPath, CLI, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      const exit = await Promise.race([child.exited, Bun.sleep(10_000).then(() => "timeout")]);
      child.kill();
      expect(exit).toBe(0);
    }
  });
});

test("bin/vault-notes runs the committed runtime with the same observable result as the source", async () => {
  const root = await vault({ "people/broken.md": BROKEN });
  for (const args of [["check", "--root", root], ["list", "--root", root, "--json"], ["inventory", "--root", root], ["--discover-command", "vault-notes.check"]]) {
    expect(run(args, [BIN])).toEqual(run(args));
  }
  const withoutRunId = (result: ReturnType<typeof run>) => ({ ...result, stdout: result.stdout.replace(/"runId":"[^"]*"/, "") });
  const resources = ["resources", "--root", root, "--updated", "2026-10-01", "--json"];
  expect(withoutRunId(run(resources, [BIN]))).toEqual(withoutRunId(run(resources)));
});

describe("bin/vault-notes through symlinks", () => {
  /** Runs a launcher path (or a bare name found on PATH) with only that directory, bun and the system on PATH. */
  function discover(launcher: string, pathDirectory?: string) {
    const bunDirectory = path.dirname(process.execPath);
    const result = Bun.spawnSync([launcher, "--discover", "--json"], {
      env: { PATH: [pathDirectory, bunDirectory, "/usr/bin", "/bin"].filter(Boolean).join(":"), HOME: tmpdir() },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    return { exit: result.exitCode, stderr: result.stderr.toString(), identity: result.exitCode === 0 ? JSON.parse(result.stdout.toString()).result.commandIdentity : null };
  }

  test("absolute, relative, chained and directory symlinks all reach the plugin's own runtime", async () => {
    const scratch = await mkdtemp(path.join(tmpdir(), "vault-notes-links-"));
    roots.push(scratch);
    const home = path.join(scratch, "home", ".local", "bin");
    const hop = path.join(scratch, "hop");
    await mkdir(home, { recursive: true });
    await mkdir(hop);
    // A PATH-style link -> absolute launcher.
    await symlink(BIN, path.join(home, "vault-notes"));
    // Chain: relative link -> relative link -> absolute link -> launcher.
    await symlink(BIN, path.join(hop, "absolute"));
    await symlink("absolute", path.join(hop, "relative"));
    await symlink(path.relative(home, path.join(hop, "relative")), path.join(home, "chained"));
    // A symlinked directory in front of the real bin/.
    await symlink(path.dirname(BIN), path.join(scratch, "bin-dir"));

    const expected = { exit: 0, stderr: "", identity: "vault-notes.discovery" };
    expect(discover(path.join(home, "vault-notes"))).toEqual(expected);
    expect(discover(path.join(home, "chained"))).toEqual(expected);
    expect(discover(path.join(scratch, "bin-dir", "vault-notes"))).toEqual(expected);
    expect(discover("vault-notes", home)).toEqual(expected);
  });
});
