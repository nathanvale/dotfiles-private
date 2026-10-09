import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkVault } from "../src/check";
import { inventoryVault } from "../src/inventory";

const CLI = path.join(import.meta.dir, "..", "src", "main.ts");
const fixtureRoots: string[] = [];
const contractSource = await Bun.file(
  path.join(import.meta.dir, "fixtures", "frontmatter-contract.json"),
).text();

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vault-check-"));
  fixtureRoots.push(root);
  await mkdir(path.join(root, "schemas"), { recursive: true });
  await mkdir(path.join(root, "people"), { recursive: true });
  await writeFile(path.join(root, "schemas", "frontmatter-contract.json"), contractSource);
  await writeFile(
    path.join(root, "README.md"),
    `---\ntitle: "Fixture Vault"\ntype: vault-index\nstatus: active\nupdated: 2026-08-06\nsummary: "Fixture root."\n---\n\n# Fixture\n`,
  );
  await writeFile(
    path.join(root, "people", "README.md"),
    `---\ntitle: "People"\ntype: family-index\nstatus: active\nupdated: 2026-08-06\nsummary: "People route."\n---\n\n# People\n`,
  );
  return root;
}

const routeByType: Record<string, string> = {
  "vault-index": "README.md",
  "family-index": "people/README.md",
  capture: "inbox/capture.md",
  person: "people/sam.md",
  organization: "organizations/example.md",
  product: "products/example.md",
  system: "systems/example.md",
  project: "projects/example/README.md",
  "project-goal": "projects/example/GOAL.md",
  "project-result": "projects/example/result.md",
  "project-spec": "projects/example/specs/feature.md",
  "project-ticket": "projects/example/tickets/feature/implement.md",
  area: "areas/example.md",
  decision: "decisions/example.md",
  reference: "reference/example.md",
  "source-artifact": "source-artifacts/example.md",
  archive: "archive/example.md",
};

function metadataForType(type: string, status: string): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    title: `Fixture ${type}`,
    type,
    status,
    updated: "2026-08-07",
    summary: `A valid ${type} fixture.`,
  };
  if (type === "person") {
    Object.assign(metadata, {
      person_id: "person_fixture",
      slug: "fixture",
      relationship_type: "friend",
      aliases: ["Fixture"],
    });
  }
  if (["project-goal", "project-result", "archive"].includes(type)) {
    metadata.related = ["canonical-owner.md"];
  }
  if (type === "source-artifact") {
    Object.assign(metadata, {
      sources: ["https://drive.google.com/file/d/fixture-drive-file-id/view"],
      source_handles: {
        drive_account: "personal",
        drive_file_id: "fixture-drive-file-id",
      },
    });
  }
  if (type === "project-spec") {
    Object.assign(metadata, {
      spec_id: "spec_fixture",
      spec_revision: "1",
      criteria: ["F-1"],
    });
  }
  if (type === "project-ticket") {
    Object.assign(metadata, {
      ticket_id: "ticket_fixture",
      spec_path: "../../specs/feature.md",
      spec_revision: "1",
      criteria: ["F-1"],
      task_identity: "fixture-task-aaaaaaaaaaaa",
    });
  }
  return metadata;
}

async function writeNote(
  root: string,
  relativePath: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const absolutePath = path.join(root, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const yaml = Bun.YAML.stringify(metadata).trimEnd();
  await writeFile(absolutePath, `---\n${yaml}\n---\n\n# Fixture\n`);
}

async function createTicketFixture(): Promise<string> {
  const root = await createFixture();
  await writeNote(root, "projects/example/specs/feature.md", metadataForType("project-spec", "accepted"));
  for (const folder of ["specs", "tickets"]) {
    await writeNote(root, `projects/example/${folder}/README.md`, metadataForType("reference", "active"));
  }
  return root;
}

describe("vault check", () => {
  test("accepts every declared note type and lifecycle status", async () => {
    const contract = JSON.parse(contractSource) as {
      statusesByType: Record<string, string[]>;
    };

    for (const [type, statuses] of Object.entries(contract.statusesByType)) {
      for (const status of statuses) {
        const root = await createFixture();
        if (type === "project-ticket") await writeNote(root, "projects/example/specs/feature.md", metadataForType("project-spec", "accepted"));
        await writeNote(root, routeByType[type]!, metadataForType(type, status));
        if (["project-spec", "project-ticket"].includes(type)) {
          for (const folder of ["specs", "tickets"]) {
            await writeNote(root, `projects/example/${folder}/README.md`, metadataForType("reference", "active"));
          }
        }
        expect(await checkVault(root)).toEqual([]);
      }
    }
  });

  test("public check enforces ticket ownership and folder maps", async () => {
    const root = await createFixture();
    await writeNote(root, "projects/example/specs/feature.md", metadataForType("project-spec", "accepted"));
    const ticketPath = "projects/example/tickets/feature/implement.md";
    const ticket = metadataForType("project-ticket", "adopted");
    await writeNote(root, ticketPath, ticket);
    for (const folder of ["specs", "tickets", "proofs"]) {
      await writeNote(root, `projects/example/${folder}/README.md`, metadataForType("reference", "active"));
    }
    const run = () => {
      const result = Bun.spawnSync([process.execPath, CLI, "check", "--root", root, "--json"]);
      return { exit: result.exitCode, findings: JSON.parse(result.stdout.toString()).findings };
    };
    expect(run()).toEqual({ exit: 0, findings: [] });
    await writeNote(root, "projects/example/proofs/feature.md", metadataForType("reference", "active"));
    for (const folder of ["specs", "tickets", "proofs"]) {
      const mapPath = `projects/example/${folder}/README.md`;
      await rm(path.join(root, mapPath));
      const missingMap = run();
      expect(missingMap.exit).toBe(1);
      expect(missingMap.findings).toContainEqual(expect.objectContaining({ file: mapPath, id: "artifact-map-missing" }));
      await writeNote(root, mapPath, metadataForType("reference", "active"));
    }
    expect(run()).toEqual({ exit: 0, findings: [] });
    await writeNote(root, ticketPath, { ...ticket, spec_path: "../../specs/missing.md" });
    expect(run().findings).toContainEqual(expect.objectContaining({ file: ticketPath, id: "ticket-spec-invalid" }));
    await writeNote(root, ticketPath, { ...ticket, spec_path: "../../proofs/README.md" });
    expect(run().findings).toContainEqual(expect.objectContaining({ id: "ticket-spec-invalid" }));
    await writeNote(root, ticketPath, ticket);
    const flat = "projects/example/tickets/flat.md";
    await writeNote(root, flat, { ...ticket, ticket_id: "flat", task_identity: "flat-task", spec_path: "../specs/feature.md" });
    const failed = run();
    expect(failed.exit).toBe(1);
    expect(failed.findings).toContainEqual(expect.objectContaining({ file: flat, id: "ticket-placement-invalid" }));
    await rm(path.join(root, flat));
    expect(run()).toEqual({ exit: 0, findings: [] });
  });

  test("accepts a correctly routed person note", async () => {
    const root = await createFixture();
    await writeFile(
      path.join(root, "people", "sam.md"),
      `---\ntitle: "Sam"\ntype: person\nstatus: active\nupdated: 2026-08-06\nsummary: "A fixture person."\nperson_id: person_sam\nslug: sam\nrelationship_type: friend\naliases:\n  - Sammy\n---\n\n# Sam\n`,
    );

    expect(await checkVault(root)).toEqual([]);
  });

  test("requires source evidence and scoped handles for source-artifact notes", async () => {
    const root = await createFixture();
    const metadata = metadataForType("source-artifact", "active");
    await writeNote(root, "source-artifacts/example.md", metadata);
    expect(await checkVault(root)).toEqual([]);

    const withoutSources = { ...metadata };
    delete withoutSources.sources;
    await writeNote(root, "source-artifacts/example.md", withoutSources);
    expect(await checkVault(root)).toContainEqual({
      file: "source-artifacts/example.md",
      id: "type-required-field-missing",
      message: "add required source-artifact field 'sources'",
    });

    await writeNote(root, "source-artifacts/example.md", {
      ...metadata,
      source_handles: ["fixture-drive-file-id"],
    });
    expect(await checkVault(root)).toContainEqual({
      file: "source-artifacts/example.md",
      id: "field-shape-invalid",
      message: "format 'source_handles' as a non-empty string map",
      detail: { field: "source_handles" },
    });
  });

  test("routes project specs and tickets through their explicit document contracts", async () => {
    const validRoot = await createFixture();
    await writeNote(
      validRoot,
      "projects/example/specs/feature.md",
      metadataForType("project-spec", "accepted"),
    );
    await writeNote(
      validRoot,
      "projects/example/tickets/feature/implement.md",
      metadataForType("project-ticket", "adopted"),
    );
    for (const folder of ["specs", "tickets"]) {
      await writeNote(validRoot, `projects/example/${folder}/README.md`, metadataForType("reference", "active"));
    }
    expect(await checkVault(validRoot)).toEqual([]);

    const wrongTypeRoot = await createFixture();
    await writeNote(
      wrongTypeRoot,
      "projects/example/specs/feature.md",
      metadataForType("reference", "active"),
    );
    expect(await checkVault(wrongTypeRoot)).toContainEqual({
      file: "projects/example/specs/feature.md",
      id: "type-path-mismatch",
      message: "change type to 'project-spec' for this path",
    });

    const missingIdentityRoot = await createFixture();
    const ticket = metadataForType("project-ticket", "adopted");
    delete ticket.task_identity;
    await writeNote(missingIdentityRoot, "projects/example/tickets/feature/implement.md", ticket);
    expect(await checkVault(missingIdentityRoot)).toContainEqual({
      file: "projects/example/tickets/feature/implement.md",
      id: "type-required-field-missing",
      message: "add required project-ticket field 'task_identity'",
    });
  });

  test("accepts nested project reference README files", async () => {
    const root = await createFixture();
    await writeNote(
      root,
      "projects/example/artifacts/README.md",
      metadataForType("reference", "active"),
    );

    expect(await checkVault(root)).toEqual([]);
  });

  test("rejects uppercase Markdown basenames outside the exact allowlist", async () => {
    const root = await createFixture();
    await writeNote(root, "people/PROFILE.md", metadataForType("person", "active"));

    expect(await checkVault(root)).toContainEqual({
      file: "people/PROFILE.md",
      id: "filename-uppercase",
      message:
        "rename Markdown filename to 'profile.md'; uppercase is reserved for 'AGENTS.md', 'CLAUDE.md', 'CONTEXT.md', 'GOAL.md', 'README.md', 'SKILL.md'",
    });
  });

  test("allows repository context, ADR, and agent-guide routes", async () => {
    const root = await createFixture();
    await mkdir(path.join(root, "docs", "agents"), { recursive: true });
    await mkdir(path.join(root, "docs", "adr"), { recursive: true });
    await mkdir(path.join(root, "docs", "notes"), { recursive: true });
    await writeFile(
      path.join(root, "CONTEXT.md"),
      `---\ntitle: "Fixture Context"\ntype: reference\nstatus: active\nupdated: 2026-08-06\nsummary: "Repository vocabulary."\n---\n\n# Context\n`,
    );
    await writeFile(
      path.join(root, "docs", "agents", "routing.md"),
      `---\ntitle: "Agent Routing"\ntype: reference\nstatus: active\nupdated: 2026-08-14\nsummary: "Detailed agent route."\n---\n\n# Agent Routing\n`,
    );
    await writeFile(
      path.join(root, "docs", "adr", "0001-fixture.md"),
      `---\ntitle: "Fixture ADR"\ntype: decision\nstatus: accepted\nupdated: 2026-08-06\nsummary: "Repository architecture decision."\n---\n\n# Fixture ADR\n`,
    );
    await writeFile(
      path.join(root, "docs", "notes", "not-routed.md"),
      `---\ntitle: "Not Routed"\ntype: reference\nstatus: active\nupdated: 2026-08-06\nsummary: "Must not inherit the ADR exception."\n---\n\n# Not Routed\n`,
    );

    expect(await checkVault(root)).toEqual([
      {
        file: "docs/notes/not-routed.md",
        id: "path-unrouted",
        message: "move this note into a routed family or add an approved routing contract",
      },
    ]);
  });

  test("ignores isolated agent worktrees", async () => {
    const root = await createFixture();
    await mkdir(path.join(root, ".worktrees", "candidate"), { recursive: true });
    await mkdir(path.join(root, ".agent-worktree", "candidate"), { recursive: true });
    await writeFile(path.join(root, ".worktrees", "candidate", "invalid.md"), "# Not a vault note\n");
    await writeFile(
      path.join(root, ".agent-worktree", "candidate", "invalid.md"),
      "# Not a vault note\n",
    );

    expect(await checkVault(root)).toEqual([]);
  });

  test("ignores project agent infrastructure", async () => {
    const root = await createFixture();
    const skillDirectory = path.join(root, ".agents", "skills", "fixture");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      path.join(skillDirectory, "SKILL.md"),
      `---\nname: fixture\ndescription: Fixture project skill.\n---\n\n# Fixture\n`,
    );

    for (const directory of [".herdr-project/thread", "my-second-brain-playgroud"]) {
      await mkdir(path.join(root, directory), { recursive: true });
      await writeFile(path.join(root, directory, "Welcome.md"), "[missing](missing.md)\n");
    }

    expect(await checkVault(root)).toEqual([]);
  });

  test("reports metadata, routing, optional-field, and link repairs", async () => {
    const root = await createFixture();
    await writeFile(
      path.join(root, "people", "broken.md"),
      `---\ntitle: "Broken"\ntype: reference\nstatus: active\nupdated: yesterday\nsummary: "Broken fixture."\nsources: []\n---\n\n[Missing](missing.md)\n`,
    );

    const messages = (await checkVault(root)).map((issue) => issue.message);
    expect(messages).toContain("change type to 'person' for this path");
    expect(messages).toContain("remove empty optional field 'sources'");
    expect(messages).toContain("format 'updated' as YYYY-MM-DD");
    expect(messages).toContain("repair missing local link 'missing.md'");
  });

  test("reports one exact repair for each malformed shared field", async () => {
    const cases: Array<[string, unknown, string]> = [
      ["title", 42, "format 'title' as a non-empty string"],
      ["type", 42, "format 'type' as a non-empty string"],
      ["status", "unknown", "use a valid status for 'person': 'active', 'inactive', 'deceased'"],
      ["updated", "yesterday", "format 'updated' as YYYY-MM-DD"],
      ["summary", 42, "format 'summary' as a non-empty string"],
    ];

    for (const [field, value, expected] of cases) {
      const root = await createFixture();
      const metadata: Record<string, unknown> = {
        title: "Sam",
        type: "person",
        status: "active",
        updated: "2026-08-06",
        summary: "A fixture person.",
        person_id: "person_sam",
        slug: "sam",
        relationship_type: "friend",
        aliases: ["Sammy"],
      };
      metadata[field] = value;
      const yaml = Bun.YAML.stringify(metadata).trimEnd();
      await writeFile(
        path.join(root, "people", "sam.md"),
        `---\n${yaml}\n---\n\n# Sam\n`,
      );

      expect(await checkVault(root)).toMatchObject([{ file: "people/sam.md", message: expected }]);
    }
  });

  test("enforces declared optional, identity, and person-extension shapes", async () => {
    const cases: Array<[string, unknown, string]> = [
      ["aliases", [42], "format 'aliases' as a non-empty list of strings"],
      ["related", "other.md", "format 'related' as a non-empty list of strings"],
      ["sources", [42], "format 'sources' as a non-empty list of strings"],
      ["source_handles", ["fixture"], "format 'source_handles' as a non-empty string map"],
      ["last_verified", "yesterday", "format 'last_verified' as YYYY-MM-DD"],
      ["person_id", 42, "format 'person_id' as a non-empty string"],
      ["project_id", 42, "format 'project_id' as a non-empty string"],
      ["slug", 42, "format 'slug' as a non-empty string"],
      ["relationship_type", 42, "format 'relationship_type' as a non-empty string"],
    ];

    for (const [field, value, expected] of cases) {
      const root = await createFixture();
      const metadata = metadataForType("person", "active");
      metadata[field] = value;
      await writeNote(root, "people/sam.md", metadata);

      expect(await checkVault(root)).toMatchObject([{ file: "people/sam.md", message: expected }]);
    }
  });

  test("rejects duplicate identities and secret-bearing fields", async () => {
    const root = await createFixture();
    const person = (title: string) =>
      `---\ntitle: "${title}"\ntype: person\nstatus: active\nupdated: 2026-08-06\nsummary: "Fixture person."\nperson_id: person_same\nslug: ${title.toLowerCase()}\nrelationship_type: friend\naliases:\n  - Friend\npassword: forbidden\n---\n\n# ${title}\n`;
    await writeFile(path.join(root, "people", "one.md"), person("One"));
    await writeFile(path.join(root, "people", "two.md"), person("Two"));

    const messages = (await checkVault(root)).map((issue) => issue.message);
    expect(messages).toContain("remove forbidden secret-bearing field 'password'");
    expect(messages).toContain(
      "replace duplicate person_id 'person_same'; first used by 'people/one.md'",
    );
  });

  test("accepts distinct superseded Tickets with the historical Task sentinel", async () => {
    const root = await createTicketFixture();
    const first = metadataForType("project-ticket", "superseded");
    const second = metadataForType("project-ticket", "superseded");
    await writeNote(root, "projects/example/tickets/feature/first.md", {
      ...first, ticket_id: "ticket_first", task_identity: "historical",
    });
    await writeNote(root, "projects/example/tickets/feature/second.md", {
      ...second, ticket_id: "ticket_second", task_identity: "historical",
    });

    expect(await checkVault(root)).toEqual([]);
  });

  test("rejects the historical Task sentinel on an adopted Ticket", async () => {
    const root = await createTicketFixture();
    await writeNote(root, "projects/example/tickets/feature/first.md", {
      ...metadataForType("project-ticket", "adopted"),
      task_identity: "historical",
    });

    expect(await checkVault(root)).toEqual([{
      file: "projects/example/tickets/feature/first.md",
      id: "field-shape-invalid",
      message: "replace 'historical' task_identity with a real Task identity for adopted project-ticket",
      detail: { field: "task_identity" },
    }]);
  });

  test("rejects duplicate real Task identities across Tickets", async () => {
    const root = await createTicketFixture();
    await writeNote(root, "projects/example/tickets/feature/first.md", {
      ...metadataForType("project-ticket", "adopted"),
      ticket_id: "ticket_first",
      task_identity: "fixture-task-aaaaaaaaaaaa",
    });
    await writeNote(root, "projects/example/tickets/feature/second.md", {
      ...metadataForType("project-ticket", "adopted"),
      ticket_id: "ticket_second",
      task_identity: "fixture-task-aaaaaaaaaaaa",
    });

    expect(await checkVault(root)).toEqual([{
      file: "projects/example/tickets/feature/second.md",
      id: "identity-duplicate",
      message: "replace duplicate task_identity 'fixture-task-aaaaaaaaaaaa'; first used by 'projects/example/tickets/feature/first.md'",
    }]);
  });

  test("rejects secret-shaped values in note bodies without echoing them", async () => {
    const root = await createFixture();
    const sentinel = "fixture-secret-value-7J4K9M2Q8R5T";
    await writeFile(
      path.join(root, "people", "sam.md"),
      `---\ntitle: "Sam"\ntype: person\nstatus: active\nupdated: 2026-08-06\nsummary: "A fixture person."\nperson_id: person_sam\nslug: sam\nrelationship_type: friend\naliases:\n  - Sammy\n---\n\n# Sam\n\napi_key = "${sentinel}"\n`,
    );

    const issues = await checkVault(root);
    expect(issues).toContainEqual({
      file: "people/sam.md",
      id: "body-secret-shaped-value",
      message:
        "remove secret-shaped value from note body at line 16; keep the value with its source owner and retain only a reference",
    });
    expect(JSON.stringify(issues)).not.toContain(sentinel);
  });
});

describe("vault inventory", () => {
  test("counts the real governed notes", async () => {
    const root = await createFixture();
    const inventory = await inventoryVault(root);

    expect(inventory.total).toBe(2);
    expect(inventory.byFamily).toEqual({ root: 1, people: 1 });
    expect(inventory.byType).toEqual({ "vault-index": 1, "family-index": 1 });
  });
});

describe("sibling-repository links", () => {
  const escapingNote = `---\ntitle: "Sibling Link"\ntype: reference\nstatus: active\nupdated: 2026-09-18\nsummary: "Links to a sibling repository."\n---\n\n[Sibling](../../dotfiles/README.md)\n`;
  const insideNote = `---\ntitle: "Inside Link"\ntype: reference\nstatus: active\nupdated: 2026-09-18\nsummary: "Links inside the vault."\n---\n\n[Inside](../people/nobody.md)\n`;
  const escapingFinding = {
    file: "reference/sibling.md",
    id: "link-missing-target" as const,
    message: "repair missing local link '../../dotfiles/README.md'",
  };

  /** Root in one temp directory, canonical layout (vault plus sibling) in another. */
  async function createSplitFixture(): Promise<{ root: string; canonical: string; home: string }> {
    const root = await createFixture();
    await mkdir(path.join(root, "reference"), { recursive: true });
    await writeFile(path.join(root, "reference", "sibling.md"), escapingNote);
    const elsewhere = await mkdtemp(path.join(tmpdir(), "vault-canonical-"));
    fixtureRoots.push(elsewhere);
    const canonical = path.join(elsewhere, "vault");
    await mkdir(path.join(canonical, "reference"), { recursive: true });
    await mkdir(path.join(elsewhere, "dotfiles"), { recursive: true });
    await writeFile(path.join(elsewhere, "dotfiles", "README.md"), "# dotfiles\n");
    const home = path.join(elsewhere, "home");
    await mkdir(home, { recursive: true });
    return { root, canonical, home };
  }

  function runCli(root: string, args: string[], env: Record<string, string>) {
    const result = spawnSync("bun", ["run", CLI, "check", "--root", root, "--json", ...args], {
      env: { PATH: process.env.PATH ?? "", ...env },
      encoding: "utf8",
    });
    return { status: result.status, findings: (JSON.parse(result.stdout) as { findings: unknown[] }).findings };
  }

  test("escaping link missing in both root and canonical reports a finding", async () => {
    const { root, canonical } = await createSplitFixture();
    await rm(path.join(path.dirname(canonical), "dotfiles"), { recursive: true });
    expect(await checkVault(root, { canonicalRoot: canonical })).toEqual([escapingFinding]);
  });

  test("escaping link present only under the canonical layout passes via option, flag, env, and config", async () => {
    const { root, canonical, home } = await createSplitFixture();
    expect(await checkVault(root)).toEqual([escapingFinding]);
    expect(await checkVault(root, { canonicalRoot: canonical })).toEqual([]);

    const noFallback = runCli(root, [], { HOME: home });
    expect(noFallback.status).toBe(1);
    expect(noFallback.findings).toEqual([{ ...escapingFinding, repair_id: null }]);

    expect(runCli(root, ["--canonical-root", canonical], { HOME: home })).toEqual({ status: 0, findings: [] });
    expect(runCli(root, [], { HOME: home, VAULT_CANONICAL_ROOT: canonical })).toEqual({ status: 0, findings: [] });

    const configHome = path.join(home, "xdg");
    await mkdir(path.join(configHome, "my-second-brain-playground"), { recursive: true });
    await writeFile(
      path.join(configHome, "my-second-brain-playground", "vault.json"),
      JSON.stringify({ schemaVersion: 1, vault: `~/${path.relative(home, canonical)}` }),
    );
    expect(runCli(root, [], { HOME: home, XDG_CONFIG_HOME: configHome })).toEqual({ status: 0, findings: [] });

    await mkdir(path.join(home, ".config", "my-second-brain-playground"), { recursive: true });
    await writeFile(
      path.join(home, ".config", "my-second-brain-playground", "vault.json"),
      JSON.stringify({ schemaVersion: 1, vault: canonical }),
    );
    expect(runCli(root, [], { HOME: home })).toEqual({ status: 0, findings: [] });
  });

  test("a missing link that stays inside the root still reports even when the canonical copy exists", async () => {
    const { root, canonical } = await createSplitFixture();
    await rm(path.join(root, "reference", "sibling.md"));
    await writeFile(path.join(root, "reference", "inside.md"), insideNote);
    await mkdir(path.join(canonical, "people"), { recursive: true });
    await writeFile(path.join(canonical, "people", "nobody.md"), "# nobody\n");
    expect(await checkVault(root, { canonicalRoot: canonical })).toEqual([
      {
        file: "reference/inside.md",
        id: "link-missing-target",
        message: "repair missing local link '../people/nobody.md'",
      },
    ]);
  });

  test("an in-root link to a gitignored canonical artifact passes only while the canonical .gitignore proves it deliberate", async () => {
    const { root, canonical } = await createSplitFixture();
    await rm(path.join(root, "reference", "sibling.md"));
    const ignoredNote = `---\ntitle: "Ignored Link"\ntype: reference\nstatus: active\nupdated: 2026-09-18\nsummary: "Links to a deliberately untracked local view."\n---\n\n[View](workbench/local.view)\n`;
    await writeFile(path.join(root, "reference", "ignored.md"), ignoredNote);

    spawnSync("git", ["init", "-q"], { cwd: canonical });
    await mkdir(path.join(canonical, "reference", "workbench"), { recursive: true });
    await writeFile(path.join(canonical, "reference", "workbench", "local.view"), "local\n");
    await writeFile(path.join(canonical, ".gitignore"), "reference/workbench/\n");

    expect(await checkVault(root, { canonicalRoot: canonical })).toEqual([]);

    await rm(path.join(canonical, ".gitignore"));
    expect(await checkVault(root, { canonicalRoot: canonical })).toEqual([
      {
        file: "reference/ignored.md",
        id: "link-missing-target",
        message: "repair missing local link 'workbench/local.view'",
      },
    ]);
  });

  test("a genuinely tracked-then-gitignored canonical target still reports as missing", async () => {
    const { root, canonical } = await createSplitFixture();
    await rm(path.join(root, "reference", "sibling.md"));
    const trackedNote = `---\ntitle: "Tracked Link"\ntype: reference\nstatus: active\nupdated: 2026-09-18\nsummary: "Links to a target genuinely tracked in canonical."\n---\n\n[Tracked](tracked/target.md)\n`;
    await writeFile(path.join(root, "reference", "tracked.md"), trackedNote);

    const gitEnv = {
      PATH: process.env.PATH ?? "",
      GIT_AUTHOR_NAME: "Vault Check Test",
      GIT_AUTHOR_EMAIL: "vault-check-test@example.invalid",
      GIT_COMMITTER_NAME: "Vault Check Test",
      GIT_COMMITTER_EMAIL: "vault-check-test@example.invalid",
    };
    const runGit = (args: string[]) => spawnSync("git", args, { cwd: canonical, env: gitEnv });

    runGit(["init", "-q"]);
    await mkdir(path.join(canonical, "reference", "tracked"), { recursive: true });
    await writeFile(path.join(canonical, "reference", "tracked", "target.md"), "# tracked\n");
    runGit(["add", "reference/tracked/target.md"]);
    runGit(["commit", "-q", "-m", "track target before it is ever ignored"]);
    // Ordinary, common history: a later .gitignore rule never retroactively untracks a file.
    await writeFile(path.join(canonical, ".gitignore"), "reference/tracked/\n");

    expect(await checkVault(root, { canonicalRoot: canonical })).toEqual([
      {
        file: "reference/tracked.md",
        id: "link-missing-target",
        message: "repair missing local link 'tracked/target.md'",
      },
    ]);
  });

  test("precedence: flag beats env beats config", async () => {
    const { root, canonical, home } = await createSplitFixture();
    const wrong = path.join(home, "wrong-vault");
    await mkdir(wrong, { recursive: true });
    await mkdir(path.join(home, ".config", "my-second-brain-playground"), { recursive: true });
    await writeFile(
      path.join(home, ".config", "my-second-brain-playground", "vault.json"),
      JSON.stringify({ schemaVersion: 1, vault: wrong }),
    );
    expect(runCli(root, [], { HOME: home }).status).toBe(1);
    expect(runCli(root, [], { HOME: home, VAULT_CANONICAL_ROOT: canonical }).status).toBe(0);
    expect(runCli(root, ["--canonical-root", wrong], { HOME: home, VAULT_CANONICAL_ROOT: canonical }).status).toBe(1);
  });
});
