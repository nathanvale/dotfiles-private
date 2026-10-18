import { type CheckResult, verdict } from "./check-result.ts";
import {
  flag,
  integer,
  type JsonRecord,
  list,
  optional,
  readJson,
  record,
  sha256File,
  text,
} from "./input.ts";

type FileIdentity = { path: string; sha256: string };

type Binding = {
  chapter: string;
  baseline: {
    path: string;
    sha256: string;
    pageCount: number;
    modified: boolean;
    capture: FileIdentity | undefined;
  };
  sourceRevision: { repository: string; commit: string };
  art: (FileIdentity & { id: string })[];
  copyResolution: FileIdentity;
};

/** Active-document readback, in the existing native receipt spelling. */
type LiveState = { path: string; modified: boolean; pageCount: number };

function identity(value: unknown, where: string): FileIdentity {
  const item = record(value, where);
  return {
    path: text(item.path, `${where}.path`),
    sha256: text(item.sha256, `${where}.sha256`),
  };
}

function readBinding(path: string): Binding {
  const root = record(readJson(path), path);
  const base = record(root.baseline, `${path}.baseline`);
  const source = record(root.sourceRevision, `${path}.sourceRevision`);
  return {
    art: list(root.art, `${path}.art`).map((entry, index) => {
      const where = `${path}.art[${index}]`;
      return {
        ...identity(entry, where),
        id: text((entry as JsonRecord).id, `${where}.id`),
      };
    }),
    baseline: {
      ...identity(base, `${path}.baseline`),
      capture: optional(base.capture, (v) =>
        identity(v, `${path}.baseline.capture`),
      ),
      modified: flag(base.modified, `${path}.baseline.modified`),
      pageCount: integer(base.pageCount, `${path}.baseline.pageCount`),
    },
    chapter: text(root.chapter, `${path}.chapter`),
    copyResolution: identity(root.copyResolution, `${path}.copyResolution`),
    sourceRevision: {
      commit: text(source.commit, `${path}.sourceRevision.commit`),
      repository: text(source.repository, `${path}.sourceRevision.repository`),
    },
  };
}

function readLive(path: string): LiveState {
  const root = record(readJson(path), path);
  return {
    modified: flag(root.modified, `${path}.modified`),
    pageCount: integer(root.page_count, `${path}.page_count`),
    path: text(root.path, `${path}.path`),
  };
}

function fileIssue(label: string, file: FileIdentity): string[] {
  const actual = sha256File(file.path);
  if (actual === null) return [`${label} ${file.path} is missing.`];
  return actual === file.sha256
    ? []
    : [`${label} ${file.path} is ${actual}, not the bound ${file.sha256}.`];
}

function documentIssues(binding: Binding, live: LiveState): string[] {
  const base = binding.baseline;
  const issues: string[] = [];
  if (live.path !== base.path) {
    issues.push(
      `build baseline ${base.path} is not the active native document ${live.path}; capture the active document and rebind.`,
    );
  }
  if (live.pageCount !== base.pageCount) {
    issues.push(
      `active document has ${live.pageCount} pages; the binding records ${base.pageCount}.`,
    );
  }
  if (live.modified !== base.modified) {
    issues.push(
      `active document modified=${live.modified}; the binding records modified=${base.modified}.`,
    );
  }
  if (!live.modified) return [...issues, ...fileIssue("baseline", base)];
  if (base.capture === undefined) {
    return [
      ...issues,
      "active document has unsaved edits but the binding has no separate baseline capture.",
    ];
  }
  return [...issues, ...fileIssue("baseline capture", base.capture)];
}

function git(repository: string, args: string[]): number {
  const run = Bun.spawnSync(["git", "-C", repository, ...args], {
    stderr: "ignore",
    stdout: "ignore",
  });
  return run.exitCode;
}

function revisionIssues(binding: Binding): string[] {
  const { repository, commit } = binding.sourceRevision;
  if (git(repository, ["cat-file", "-e", `${commit}^{commit}`]) !== 0) {
    return [`source revision ${commit} is not a commit in ${repository}.`];
  }
  return git(repository, ["merge-base", "--is-ancestor", commit, "HEAD"]) === 0
    ? []
    : [`source revision ${commit} is not on the current HEAD of ${repository}.`];
}

export function checkBaseline(bindingPath: string, livePath: string): CheckResult {
  const binding = readBinding(bindingPath);
  const live = readLive(livePath);
  const issues = [
    ...documentIssues(binding, live),
    ...revisionIssues(binding),
    ...binding.art.flatMap((art) => fileIssue(`art ${art.id}`, art)),
    ...fileIssue("copy resolution", binding.copyResolution),
  ];
  return verdict(
    issues,
    {
      art: binding.art,
      baseline: binding.baseline.capture ?? {
        path: binding.baseline.path,
        sha256: binding.baseline.sha256,
      },
      chapter: binding.chapter,
      copyResolution: binding.copyResolution,
      pageCount: binding.baseline.pageCount,
      sourceRevision: binding.sourceRevision,
    },
    "Build binding matches the active native baseline and bound inputs.",
    "Build binding does not match the active native baseline or bound inputs.",
    "Stop before native effects. Capture the active document, rebind baseline, source, art and copy, then rerun baseline.",
  );
}
