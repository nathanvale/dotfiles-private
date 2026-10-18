import { type CheckResult, verdict } from "./check-result.ts";
import { type Frame, readFrames } from "./frames.ts";
import { UsageError } from "./usage.ts";

type PageMap = { before: number; after: number };

/** Parses "1-9,12>14": single pages, ranges and before>after moves. */
function parsePages(spec: string): PageMap[] {
  return spec.split(",").flatMap((part) => {
    const move = /^(\d+)>(\d+)$/.exec(part);
    if (move) return [{ after: Number(move[2]), before: Number(move[1]) }];
    const range = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!range) {
      throw new UsageError(`--pages entry "${part}" is not N, N-M or N>M.`);
    }
    const first = Number(range[1]);
    const last = Number(range[2] ?? range[1]);
    if (last < first) throw new UsageError(`--pages range "${part}" is reversed.`);
    return Array.from({ length: last - first + 1 }, (_, i) => ({
      after: first + i,
      before: first + i,
    }));
  });
}

function canonical(item: Frame): string {
  return JSON.stringify({
    bounds: item.bounds,
    fill: item.fill,
    kind: item.kind,
    ranges: item.ranges,
    visible: item.visible,
  });
}

function byLabel(frames: Frame[], page: number): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const item of frames.filter((f) => f.page === page)) {
    out.set(item.label, [...(out.get(item.label) ?? []), canonical(item)].sort());
  }
  return out;
}

function pageIssues(before: Frame[], after: Frame[], map: PageMap): string[] {
  const was = byLabel(before, map.before);
  const now = byLabel(after, map.after);
  const where = `page ${map.before}→${map.after}`;
  if (was.size === 0) return [`${where}: before has no frames to protect.`];
  const labels = [...new Set([...was.keys(), ...now.keys()])].sort();
  return labels.flatMap((label) => {
    const a = was.get(label);
    const b = now.get(label);
    if (a === undefined) return [`${where}: frame "${label}" was added.`];
    if (b === undefined) return [`${where}: frame "${label}" was removed.`];
    return JSON.stringify(a) === JSON.stringify(b)
      ? []
      : [`${where}: frame "${label}" geometry, text or typography changed.`];
  });
}

export function checkProtected(
  beforePath: string,
  afterPath: string,
  pages: string,
): CheckResult {
  const map = parsePages(pages);
  const before = readFrames(beforePath);
  const after = readFrames(afterPath);
  const issues = map.flatMap((entry) => pageIssues(before, after, entry));
  return verdict(
    issues,
    { protectedPages: map },
    `${map.length} protected pages keep their frames, text and typography.`,
    "Protected pages changed after the build.",
    "Inspect the changed frames against the captured baseline; restore them or record an authorized change before handback.",
  );
}
