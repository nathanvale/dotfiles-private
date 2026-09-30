// Resources Index: the check rules (through checkVault and the check command) and the inspect-only
// `vault-notes resources` front door. Every expected path, finding and file body below is a test-owned literal.
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkVault } from "../src/check";

const CLI = path.join(import.meta.dir, "..", "src", "main.ts");
const CONTRACT = await Bun.file(path.join(import.meta.dir, "fixtures", "frontmatter-contract.json")).text();
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function note(title: string, type: string, status: string, summary: string, body = ""): string {
  return `---\ntitle: ${JSON.stringify(title)}\ntype: ${type}\nstatus: ${status}\nupdated: 2026-09-30\nsummary: ${JSON.stringify(summary)}\n---\n\n# ${title}\n${body}`;
}

const ROUTE = "\n- [Resources index](resources.md): every note this project owns.\n";

/**
 * Three projects. alpha holds every placement the rules distinguish: packet, root proof and decision, nested
 * research, a ticket-shaped wayfinding note, a superseded decision log, a nested research README, and a governed
 * proofs folder whose note is typed `reference`. beta holds only its README. gamma owns one research note.
 */
const PROJECTS: Record<string, string> = {
  "README.md": note("Fixture Vault", "vault-index", "active", "Fixture root."),
  "projects/README.md": note("Projects", "family-index", "active", "Projects route."),
  "projects/alpha/README.md": note("Alpha", "project", "active", "Alpha packet."),
  "projects/alpha/plan.md": note("Alpha Plan [v2]", "decision", "accepted", "Accepted plan."),
  "projects/alpha/proof.md": note("Alpha Proof", "reference", "active", "Root proof record."),
  "projects/alpha/research/README.md": note("Alpha Research", "reference", "active", "Research folder map."),
  "projects/alpha/research/deep/finding.md": note("Deep Finding", "reference", "active", "A nested research finding."),
  "projects/alpha/wayfinding/tickets/01-choose.md": note("Choose A Venue", "reference", "archived", "Resolved ticket-shaped note."),
  "projects/alpha/decisions/log.md": note("Alpha Decisions", "decision", "superseded", "Earlier decision log."),
  "projects/alpha/proofs/README.md": note("Alpha Proofs", "reference", "active", "Proof folder map."),
  "projects/alpha/proofs/run.md": note("Alpha Proof Run", "reference", "active", "Governed proof artifact."),
  "projects/beta/README.md": note("Beta", "project", "archived", "Beta packet."),
  "projects/gamma/README.md": note("Gamma", "project", "active", "Gamma packet."),
  "projects/gamma/research/x.md": note("Gamma Research", "reference", "active", "Owned by gamma."),
};

const ACTIVE_CONTRACT = JSON.stringify({ ...JSON.parse(CONTRACT), projectResources: { indexFile: "resources.md" } });

/**
 * The active contract plus other routes into a project: `meetings` to its own type, `notes` to `reference`, and a
 * repository prefix route for gamma's `log/` folder.
 */
function contractWithDirectories(): string {
  const parsed = JSON.parse(ACTIVE_CONTRACT);
  parsed.routing.projectDirectories = { ...parsed.routing.projectDirectories, meetings: "meeting", notes: "reference" };
  parsed.routing.repositoryPrefixes = { ...parsed.routing.repositoryPrefixes, "projects/gamma/log/": "capture" };
  parsed.statusesByType = { ...parsed.statusesByType, meeting: ["active"] };
  return JSON.stringify(parsed);
}

async function vault(files: Record<string, string>, contract = ACTIVE_CONTRACT): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vault-resources-"));
  roots.push(root);
  await mkdir(path.join(root, "schemas"));
  await writeFile(path.join(root, "schemas", "frontmatter-contract.json"), contract);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return root;
}

function run(args: string[]) {
  const home = path.join(tmpdir(), "vault-resources-no-home");
  const result = Bun.spawnSync([process.execPath, CLI, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: path.join(home, "xdg") },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exit: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

interface Proposal {
  project: string;
  indexPath: string;
  notes: string[];
  folderMaps: string[];
  state: string;
  content: string | null;
  findings: { id: string; file: string; message: string; detail: Record<string, string> }[];
}

function propose(root: string, ...projects: string[]) {
  const result = run(["resources", "--root", root, "--updated", "2026-10-01", "--json", ...projects.flatMap((slug) => ["--project", slug])]);
  expect([result.exit, result.stderr]).toEqual([0, ""]);
  const body = JSON.parse(result.stdout);
  return body.result.data as { active: boolean; indexFile: string; projects: Proposal[] };
}

/** Write each proposed index and add the README route: the migration a Steward candidate would perform. */
async function migrate(root: string): Promise<void> {
  for (const proposal of propose(root).projects) {
    await writeFile(path.join(root, proposal.indexPath), proposal.content ?? "");
    const readme = path.join(root, "projects", proposal.project, "README.md");
    await writeFile(readme, (await readFile(readme, "utf8")) + ROUTE);
  }
}

async function edit(root: string, file: string, change: (content: string) => string): Promise<void> {
  const target = path.join(root, file);
  await writeFile(target, change(await readFile(target, "utf8")));
}

const findings = async (root: string) => (await checkVault(root)).map((issue) => [issue.id, issue.file, issue.detail ?? {}]);

const ALPHA_INDEX = `---
title: "Alpha resources"
type: reference
status: active
updated: 2026-10-01
summary: "Resources Index for Alpha: every reference and decision note the project owns, plus curated shared resources."
related:
  - README.md
---

# Alpha resources

Back to the [project packet](README.md).

## Shared resources

Notes owned elsewhere appear here only by explicit, curated association. Regeneration never adds or removes them.

<!-- project-resources:shared:start -->
<!-- project-resources:shared:end -->

## Project-owned notes

<!-- project-resources:generated:start -->
<!-- Generated by vault-notes resources from each note's frontmatter. Regeneration replaces this block; curate shared notes above. -->

### Folder maps

- [Alpha Proofs](proofs/README.md): Proof folder map.
- [Alpha Research](research/README.md): Research folder map.

### Project root

- [Alpha Plan \\[v2\\]](plan.md): Accepted plan.
- [Alpha Proof](proof.md): Root proof record.

### decisions

- [Alpha Decisions](decisions/log.md) _(superseded)_: Earlier decision log.

### research/deep

- [Deep Finding](research/deep/finding.md): A nested research finding.

### wayfinding/tickets

- [Choose A Venue](wayfinding/tickets/01-choose.md) _(archived)_: Resolved ticket-shaped note.
<!-- project-resources:generated:end -->
`;

const EMPTY_BLOCK = `<!-- project-resources:generated:start -->
<!-- Generated by vault-notes resources from each note's frontmatter. Regeneration replaces this block; curate shared notes above. -->

_No project-owned reference or decision notes yet._
<!-- project-resources:generated:end -->
`;

describe("activation", () => {
  test("without the contract key every rule is inert; with it, missing indexes and routes are findings", async () => {
    const inactive = await vault(PROJECTS, CONTRACT);
    expect(await checkVault(inactive)).toEqual([]);
    expect(run(["check", "--root", inactive])).toEqual({ exit: 0, stdout: "Vault check passed.\n", stderr: "" });

    const active = await vault(PROJECTS);
    expect(await findings(active)).toEqual([
      ["resources-route-missing", "projects/alpha/README.md", { project: "alpha", target: "resources.md" }],
      ["resources-index-missing", "projects/alpha/resources.md", { project: "alpha" }],
      ["resources-route-missing", "projects/beta/README.md", { project: "beta", target: "resources.md" }],
      ["resources-index-missing", "projects/beta/resources.md", { project: "beta" }],
      ["resources-route-missing", "projects/gamma/README.md", { project: "gamma", target: "resources.md" }],
      ["resources-index-missing", "projects/gamma/resources.md", { project: "gamma" }],
    ]);
    expect(run(["check", "--root", active]).stderr).toBe(
      [
        "projects/alpha/README.md: link the Resources Index from this README, for example '- [Resources index](resources.md)'",
        "projects/alpha/resources.md: create this Resources Index; regenerate with 'vault-notes resources --project alpha'",
        "projects/beta/README.md: link the Resources Index from this README, for example '- [Resources index](resources.md)'",
        "projects/beta/resources.md: create this Resources Index; regenerate with 'vault-notes resources --project beta'",
        "projects/gamma/README.md: link the Resources Index from this README, for example '- [Resources index](resources.md)'",
        "projects/gamma/resources.md: create this Resources Index; regenerate with 'vault-notes resources --project gamma'",
        "",
        "6 issues found.",
        "",
      ].join("\n"),
    );
  });

  test("a malformed key fails the check and refuses resources instead of silently switching the rules off", async () => {
    const cases: [unknown, string][] = [
      [true, "fix 'projectResources': it must be an object"],
      [{ indexfile: "resources.md" }, "fix 'projectResources': remove unknown key 'indexfile'"],
      [{ indexFile: "Resources.md" }, "fix 'projectResources': 'indexFile' must be a lowercase Markdown file name such as 'resources.md'"],
      [{ indexFile: "notes/resources.md" }, "fix 'projectResources': 'indexFile' must be a lowercase Markdown file name such as 'resources.md'"],
      [{ indexFile: "result.md" }, "fix 'projectResources': 'indexFile' must not be the project packet file 'result.md'"],
    ];
    for (const [key, message] of cases) {
      const root = await vault(PROJECTS, JSON.stringify({ ...JSON.parse(CONTRACT), projectResources: key }));
      expect(await checkVault(root)).toEqual([
        { id: "resources-contract-invalid", file: "schemas/frontmatter-contract.json", message, detail: { field: "projectResources" } },
      ]);
      const refused = run(["resources", "--root", root, "--json"]);
      expect(refused.exit).toBe(4);
      expect(JSON.parse(refused.stdout).result.causeCode).toBe("SCHEMA_CONFIG_INVALID");
    }
  });
});

describe("generation", () => {
  test("a new index lists every owned reference and decision note at any depth, and nothing else", async () => {
    const root = await vault(PROJECTS);
    const [alpha, beta] = propose(root, "alpha", "beta").projects as [Proposal, Proposal];

    expect(alpha.notes).toEqual([
      "projects/alpha/decisions/log.md",
      "projects/alpha/plan.md",
      "projects/alpha/proof.md",
      "projects/alpha/research/deep/finding.md",
      "projects/alpha/wayfinding/tickets/01-choose.md",
    ]);
    expect(alpha.folderMaps).toEqual(["projects/alpha/proofs/README.md", "projects/alpha/research/README.md"]);
    expect([alpha.state, alpha.content]).toEqual(["create", ALPHA_INDEX]);
    expect([beta.notes, beta.folderMaps, beta.state]).toEqual([[], [], "create"]);
    expect(beta.content?.endsWith(`## Project-owned notes\n\n${EMPTY_BLOCK}`)).toBe(true);
  });

  test("once every index and route is written the check passes and regeneration changes nothing", async () => {
    const root = await vault(PROJECTS);
    await migrate(root);

    expect(await checkVault(root)).toEqual([]);
    const again = propose(root);
    expect(again.active).toBe(true);
    for (const proposal of again.projects) {
      expect([proposal.project, proposal.state, proposal.findings]).toEqual([proposal.project, "current", []]);
      expect(proposal.content).toBe(await readFile(path.join(root, proposal.indexPath), "utf8"));
    }
  });

  test("regeneration replaces only the generated block: preamble, labels and shared entries keep their bytes", async () => {
    const root = await vault(PROJECTS);
    await migrate(root);
    const human = (content: string) =>
      content
        .replace("Back to the [project packet](README.md).", "Back to the [project packet](README.md).\n\n> Label carried from the README: fictional.")
        .replace("<!-- project-resources:shared:start -->", "<!-- project-resources:shared:start -->\n- [Gamma Research](../gamma/research/x.md): curated by hand.");
    await edit(root, "projects/alpha/resources.md", (content) => human(content).replace("- [Alpha Proof](proof.md): Root proof record.\n", ""));

    expect(await findings(root)).toEqual([
      ["resources-entry-missing", "projects/alpha/resources.md", { project: "alpha", path: "proof.md" }],
    ]);
    const [alpha] = propose(root, "alpha").projects as [Proposal];
    expect([alpha.state, alpha.content]).toEqual(["update", human(ALPHA_INDEX)]);
  });

  test("an index without a generated block gets one appended; broken markers block regeneration", async () => {
    const root = await vault(PROJECTS);
    await migrate(root);
    await writeFile(path.join(root, "projects/beta/resources.md"), note("Beta resources", "reference", "active", "Hand-written index."));
    await edit(root, "projects/alpha/resources.md", (content) => `${content}<!-- project-resources:generated:start -->\n`);

    expect(await findings(root)).toEqual([
      ["resources-block-invalid", "projects/alpha/resources.md", { project: "alpha" }],
      ["resources-block-invalid", "projects/beta/resources.md", { project: "beta" }],
    ]);
    const [alpha, beta] = propose(root, "alpha", "beta").projects as [Proposal, Proposal];
    expect([alpha.state, alpha.content]).toEqual(["blocked", null]);
    expect(beta.state).toBe("update");
    expect(beta.content).toBe(
      `${note("Beta resources", "reference", "active", "Hand-written index.")}\n## Project-owned notes\n\n${EMPTY_BLOCK}`,
    );
  });

  test("only notes routed to reference or decision are owned: other directory, packet-name and prefix routes are not", async () => {
    const related = (content: string) => content.replace("---\n\n#", "related:\n  - ../README.md\n---\n\n#");
    const root = await vault(
      {
        ...PROJECTS,
        "projects/gamma/meetings/weekly.md": note("Weekly", "meeting", "active", "A meeting record."),
        "projects/gamma/notes/idea.md": note("Idea", "reference", "active", "A routed reference note."),
        "projects/gamma/research/GOAL.md": related(note("Research Goal", "project-goal", "active", "A nested goal file.")),
        "projects/gamma/research/result.md": related(note("Research Result", "project-result", "final", "A nested result file.")),
        "projects/gamma/log/entry.md": note("Log Entry", "capture", "triage", "A prefix-routed capture."),
      },
      contractWithDirectories(),
    );
    const [gamma] = propose(root, "gamma").projects as [Proposal];
    expect(gamma.notes).toEqual(["projects/gamma/notes/idea.md", "projects/gamma/research/x.md"]);

    await migrate(root);
    expect(await checkVault(root)).toEqual([]);
  });

  test("links inside a note's title or summary become plain labels, so the generated index passes check", async () => {
    const root = await vault({
      ...PROJECTS,
      // Each link resolves from the source note's folder; copied verbatim into resources.md, each would break.
      "projects/gamma/research/x.md": note(
        "Gamma [draft](chart.png) Research",
        "reference",
        "active",
        "Moved from [the old note](../../alpha/proof.md), see [site](https://example.com) and ![a chart](chart.png); odd ](text.",
      ),
      "projects/gamma/research/chart.png": "not a note",
    });
    const [gamma] = propose(root, "gamma").projects as [Proposal];
    expect(gamma.content).toContain(
      "\n- [Gamma draft Research](research/x.md): Moved from the old note, see site and a chart; odd ] (text.\n",
    );

    await migrate(root);
    expect(await checkVault(root)).toEqual([]);
  });
});

describe("entry rules", () => {
  test("omitting an owned note, or adding one without its entry, is reported", async () => {
    const root = await vault(PROJECTS);
    await migrate(root);
    await edit(root, "projects/alpha/resources.md", (content) =>
      content.replace("- [Deep Finding](research/deep/finding.md): A nested research finding.\n", ""),
    );
    await writeFile(path.join(root, "projects/gamma/research/new.md"), note("New Gamma Note", "decision", "accepted", "Added later."));

    expect(await findings(root)).toEqual([
      ["resources-entry-missing", "projects/alpha/resources.md", { project: "alpha", path: "research/deep/finding.md" }],
      ["resources-entry-missing", "projects/gamma/resources.md", { project: "gamma", path: "research/new.md" }],
    ]);
  });

  test("stale, duplicate and foreign entries are reported, and a broken entry link stays a link finding", async () => {
    const root = await vault(PROJECTS);
    await migrate(root);
    const extra = [
      "- [Gone](research/gone.md): moved away.",
      "- [Proof again](./proof.md#top): listed twice.",
      "- [Governed](proofs/run.md): a governed artifact.",
      "- [Packet](README.md): the packet.",
      "- [Gamma](../gamma/research/x.md): owned by gamma.",
      "- [Site](https://example.com): external.",
    ].join("\n");
    await edit(root, "projects/alpha/resources.md", (content) =>
      content.replace("<!-- project-resources:generated:end -->", `${extra}\n<!-- project-resources:generated:end -->`),
    );

    expect(await findings(root)).toEqual([
      ["link-missing-target", "projects/alpha/resources.md", {}],
      ["resources-entry-stale", "projects/alpha/resources.md", { project: "alpha", target: "research/gone.md" }],
      ["resources-entry-duplicate", "projects/alpha/resources.md", { project: "alpha", target: "./proof.md#top" }],
      ["resources-entry-stale", "projects/alpha/resources.md", { project: "alpha", target: "proofs/run.md" }],
      ["resources-entry-stale", "projects/alpha/resources.md", { project: "alpha", target: "README.md" }],
      ["resources-entry-foreign", "projects/alpha/resources.md", { project: "alpha", target: "../gamma/research/x.md" }],
      ["resources-entry-foreign", "projects/alpha/resources.md", { project: "alpha", target: "https://example.com" }],
    ]);
  });

  test("a route hidden in an HTML comment or a fenced code block does not count; one after a closed fence does", async () => {
    const root = await vault(PROJECTS);
    await migrate(root);
    const hidden = {
      alpha: "\n<!--\n- [Resources index](resources.md)\n-->\n",
      beta: "\n```markdown\n- [Resources index](resources.md)\n```\n",
      gamma: "\n~~~~\n~~~\n- [Code](resources.md)\n~~~~\n\nAfter the fence: [Resources index](resources.md).\n",
    };
    for (const [project, text] of Object.entries(hidden)) {
      await edit(root, `projects/${project}/README.md`, (content) => content.replace(ROUTE, text));
    }

    expect(await findings(root)).toEqual([
      ["resources-route-missing", "projects/alpha/README.md", { project: "alpha", target: "resources.md" }],
      ["resources-route-missing", "projects/beta/README.md", { project: "beta", target: "resources.md" }],
    ]);
  });

  test("the README route may sit anywhere and take any local spelling; without it the route is missing", async () => {
    const root = await vault(PROJECTS);
    await migrate(root);
    await edit(root, "projects/alpha/README.md", (content) => content.replace(ROUTE, "\nSee the [index](./resources.md#project-owned-notes) first.\n"));
    await edit(root, "projects/beta/README.md", (content) =>
      content.replace(ROUTE, "\n- [This packet](README.md)\n- [Another index](../gamma/resources.md)\n- [Site](https://example.com/resources.md)\n"),
    );

    expect(await findings(root)).toEqual([
      ["resources-route-missing", "projects/beta/README.md", { project: "beta", target: "resources.md" }],
    ]);
  });
});

describe("vault-notes resources front door", () => {
  const station = (args: string[]) => {
    const result = run([...args, "--json"]);
    const { causeCode, outcome, failureClass, exitCode, transactionState, data } = JSON.parse(result.stdout).result;
    return { exit: result.exit, stderr: result.stderr, causeCode, outcome, failureClass, exitCode, transactionState, data };
  };

  test("every declared station is reached with its declared exit, and no undeclared station exists", async () => {
    const root = await vault(PROJECTS);
    const unreadable = await vault({ ...PROJECTS, "projects/alpha/locked.md": note("Locked", "reference", "active", "Locked.") });
    await chmod(path.join(unreadable, "projects/alpha/locked.md"), 0o000);
    const noContract = path.join(root, "projects");
    const scenarios: Record<string, string[]> = {
      SUCCESS_UNCHANGED: ["resources", "--root", root],
      USAGE_INVALID_INVOCATION: ["resources", "--root", root, "--root", root],
      SCHEMA_INVALID_INPUT: ["resources", "--root", root, "--updated", "2026-02-30"],
      DOMAIN_VAULT_NOT_FOUND: ["resources", "--root", noContract],
      SCHEMA_CONFIG_INVALID: ["resources", "--root", await vault(PROJECTS, "{ not json")],
      DOMAIN_PRECONDITION_UNMET: ["resources", "--root", root, "--project", "delta"],
      INTERNAL_PREPARATION: ["resources", "--root", unreadable],
    };
    const expected: Record<string, [number, string]> = {
      SUCCESS_UNCHANGED: [0, "success"],
      USAGE_INVALID_INVOCATION: [2, "refused"],
      SCHEMA_INVALID_INPUT: [4, "refused"],
      DOMAIN_VAULT_NOT_FOUND: [3, "refused"],
      SCHEMA_CONFIG_INVALID: [4, "refused"],
      DOMAIN_PRECONDITION_UNMET: [3, "refused"],
      INTERNAL_PREPARATION: [1, "refused"],
    };
    const declared = JSON.parse(run(["--discover-command", "vault-notes.resources", "--json"]).stdout).result.data.stations as {
      causeCode: string;
      exitCode: number;
    }[];
    // Serialization and emission failures need a broken runtime or stdout; the shared control-path tests own them.
    const reachable = declared.filter((row) => !row.causeCode.startsWith("INTERNAL_RESULT_"));
    expect(reachable.map((row) => [row.causeCode, row.exitCode]).sort()).toEqual(
      Object.entries(expected).map(([cause, [exit]]) => [cause, exit]).sort(),
    );
    for (const [cause, args] of Object.entries(scenarios)) {
      if (cause === "INTERNAL_PREPARATION" && process.getuid?.() === 0) continue;
      const [exit, outcome] = expected[cause] ?? [];
      const observed = station(args);
      expect([cause, observed.exit, observed.causeCode, observed.outcome, observed.transactionState, observed.stderr]).toEqual([
        cause,
        exit,
        cause,
        outcome,
        "unchanged",
        "",
      ]);
    }
  });

  test("usage and value refusals name the problem; human mode prints the repair on stderr", async () => {
    const root = await vault(PROJECTS);
    const human = (args: string[]) => run(["resources", "--root", root, ...args]);
    expect(human(["--frobnicate", "x"])).toEqual({
      exit: 2,
      stdout: "",
      stderr:
        "resources does not accept '--frobnicate'. Repair: Choose check, list, inventory, resources, --help, --discover or --discover-command COMMAND_IDENTITY with its listed options and retry.\n",
    });
    expect(human(["--project"]).stderr).toStartWith("--project needs a value. Repair:");
    expect(human(["--project", "alpha", "--project", "alpha"]).stderr).toStartWith("Name each --project once. Repair:");
    expect(human(["--project", "Alpha/../x"])).toEqual({
      exit: 4,
      stdout: "",
      stderr:
        "--project 'Alpha/../x' is not a lowercase project slug. Repair: Pass --project as a folder name under projects/ and --updated as YYYY-MM-DD, then retry.\n",
    });
  });

  test("human output summarises each proposal and its findings without writing anything", async () => {
    const root = await vault(PROJECTS, CONTRACT);
    const before = await readFile(path.join(root, "projects/alpha/README.md"), "utf8");
    expect(run(["resources", "--root", root, "--project", "beta"])).toEqual({
      exit: 0,
      stdout: [
        "Resources Index proposals (resources.md; check rules inactive until the contract declares projectResources):",
        "projects/beta/resources.md: create (0 notes, 0 folder maps, 2 findings)",
        "  resources-route-missing projects/beta/README.md: link the Resources Index from this README, for example '- [Resources index](resources.md)'",
        "  resources-index-missing projects/beta/resources.md: create this Resources Index; regenerate with 'vault-notes resources --project beta'",
        "",
        "Content is in --json output: result.data.projects[].content. Nothing was written.",
        "",
      ].join("\n"),
      stderr: "",
    });
    expect(await readFile(path.join(root, "projects/alpha/README.md"), "utf8")).toBe(before);
    expect(await Bun.file(path.join(root, "projects/beta/resources.md")).exists()).toBe(false);
  });

  test("resources help is the shared help, and command discovery names the finding IDs and the contract key", () => {
    expect(run(["resources", "--help"])).toEqual(run(["--help"]));
    expect(run(["resources", "--discover"])).toEqual(run(["--discover"]));
    const { data } = JSON.parse(run(["--discover-command", "vault-notes.resources", "--json"]).stdout).result;
    expect(data.findingIds).toEqual([
      "resources-contract-invalid",
      "resources-route-missing",
      "resources-index-missing",
      "resources-block-invalid",
      "resources-entry-missing",
      "resources-entry-stale",
      "resources-entry-foreign",
      "resources-entry-duplicate",
    ]);
    expect(data.contractKey).toMatchObject({ file: "schemas/frontmatter-contract.json", key: "projectResources", shape: { indexFile: "resources.md" } });
  });
});
