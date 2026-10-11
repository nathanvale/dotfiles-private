import { type CheckResult, verdict } from "./check-result.ts";
import {
  anyText,
  InputError,
  integer,
  type JsonRecord,
  list,
  readJson,
  optional,
  readText,
  record,
  text,
} from "./input.ts";

/** One native story: its whole contents (including overset) and style ranges. */
export type Story = { label: string; page: number | undefined; text: string; ranges: JsonRecord[] };

/** Stable story address: pPAGE:LABEL when the readback gives the page. */
function storyKey(item: Story): string {
  return item.page === undefined ? item.label : `p${item.page}:${item.label}`;
}

/**
 * Finds one story by its key, or by a label no other story shares. Several
 * matches fail closed: labels such as heading repeat on every page.
 */
export function findStory(stories: Story[], target: string, readback: string): { story?: Story; issue?: string } {
  const matches = stories.filter((s) => storyKey(s) === target || s.label === target);
  if (matches.length === 1) return { story: matches[0] as Story };
  if (matches.length === 0) return {};
  return { issue: `target "${target}" is ambiguous in the ${readback} readback: ${matches.map(storyKey).join(", ")}.` };
}

function duplicateKeyIssues(stories: Story[], readback: string): string[] {
  const counts = new Map<string, number>();
  for (const item of stories) counts.set(storyKey(item), (counts.get(storyKey(item)) ?? 0) + 1);
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([key, count]) => `${readback} readback has ${count} stories keyed "${key}"; add page to each story.`);
}

const EMOJI_PART =
  /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|[\u{1F3FB}-\u{1F3FF}]|\u200D|\uFE0F|\u20E3/gu;

function hasEmoji(value: string): boolean {
  return value.replace(EMOJI_PART, "") !== value;
}

function onlyEmoji(value: string): boolean {
  return value.length > 0 && value.replace(EMOJI_PART, "") === "";
}

function story(value: unknown, where: string): Story {
  const item = record(value, where);
  const page = optional(item.page, (v) => integer(v, `${where}.page`));
  if (page !== undefined && page < 1) throw new InputError(`${where}.page must be positive.`);
  return {
    label: text(item.label, `${where}.label`),
    page,
    ranges: list(item.ranges, `${where}.ranges`).map((range, index) => {
      const entry = record(range, `${where}.ranges[${index}]`);
      anyText(entry.text, `${where}.ranges[${index}].text`);
      return entry;
    }),
    text: anyText(item.text, `${where}.text`),
  };
}

export function readStories(path: string): Story[] {
  const root = record(readJson(path), path);
  return list(root.stories, `${path}.stories`).map((entry, index) =>
    story(entry, `${path}.stories[${index}]`),
  );
}

/** Shows invisible characters so a mismatch is readable in one line. */
function visible(value: string): string {
  return JSON.stringify(value).replace(/ /g, "\\u00a0");
}

/** Native paragraphs end at \r; selected text separates them with one blank line. */
export function nativeParagraphs(value: string): string[] {
  return value.split("\r");
}

function expectedParagraphs(value: string): string[] {
  return value.replace(/\n$/, "").split("\n\n");
}

function textIssues(target: Story, expected: string[]): string[] {
  const native = nativeParagraphs(target.text);
  const length = Math.max(native.length, expected.length);
  for (let index = 0; index < length; index += 1) {
    const want = expected[index];
    const got = native[index];
    if (want === got) continue;
    if (want === undefined) {
      return [
        `story "${storyKey(target)}" has an extra paragraph ${index + 1} ${visible(got ?? "")} (old tail?).`,
      ];
    }
    return [
      `story "${storyKey(target)}" paragraph ${index + 1} is ${visible(got ?? "<missing>")}; expected ${visible(want)}.`,
    ];
  }
  return [];
}

function formatting(range: JsonRecord): string {
  const { text: _text, ...rest } = range;
  return JSON.stringify(Object.entries(rest).sort(([a], [b]) => a.localeCompare(b)));
}

function rangeIssues(target: Story, emojiFont: string | undefined): string[] {
  const issues: string[] = [];
  const plainByStyle = new Map<string, Set<string>>();
  for (const range of target.ranges) {
    const value = String(range.text);
    const emoji = hasEmoji(value);
    const emojiFontRange = emojiFont !== undefined && range.font === emojiFont;
    if (emoji && (!emojiFontRange || !onlyEmoji(value))) {
      issues.push(
        `story "${storyKey(target)}" range ${visible(value)} mixes emoji with other text or lacks the emoji font.`,
      );
    } else if (emojiFontRange && !emoji) {
      issues.push(
        `story "${storyKey(target)}" range ${visible(value)} has the emoji font but no emoji.`,
      );
    } else if (!emoji) {
      const style = String(range.style ?? "");
      plainByStyle.set(
        style,
        (plainByStyle.get(style) ?? new Set()).add(formatting(range)),
      );
    }
  }
  for (const [style, variants] of plainByStyle) {
    if (variants.size > 1) {
      issues.push(
        `story "${storyKey(target)}" style "${style}" carries ${variants.size} formatting variants; clear inherited local overrides.`,
      );
    }
  }
  return issues;
}

function consistencyIssues(stories: Story[], label: string): string[] {
  return stories.flatMap((s) =>
    s.ranges.map((r) => String(r.text)).join("") === s.text
      ? []
      : [`${label} story "${storyKey(s)}" ranges do not reproduce its text.`],
  );
}

/** Compares by unique key; callers refuse readbacks whose keys repeat. */
function protectedIssues(before: Story[], after: Story[], target: Story | undefined): string[] {
  const now = new Map(after.map((s) => [storyKey(s), JSON.stringify(s)]));
  return before
    .filter((s) => s !== target)
    .flatMap((s) => {
      const after = now.get(storyKey(s));
      if (after === undefined) return [`protected story "${storyKey(s)}" was removed.`];
      return after === JSON.stringify(s)
        ? []
        : [`protected story "${storyKey(s)}" text or formatting changed.`];
    });
}

function targetIssues(
  before: ReturnType<typeof findStory>,
  after: ReturnType<typeof findStory>,
  target: string,
): string[] {
  const issues = [before.issue, after.issue].filter((issue): issue is string => issue !== undefined);
  if (after.story === undefined && after.issue === undefined) {
    issues.push(`after readback has no story "${target}".`);
  }
  if (before.story && after.story && storyKey(before.story) !== storyKey(after.story)) {
    issues.push(`target "${target}" is ${storyKey(before.story)} before and ${storyKey(after.story)} after.`);
  }
  return issues;
}

export function checkStory(options: {
  before: string;
  after: string;
  target: string;
  expected: string;
  emojiFont: string | undefined;
}): CheckResult {
  const before = readStories(options.before);
  const after = readStories(options.after);
  const expected = expectedParagraphs(readText(options.expected));
  const was = findStory(before, options.target, "before");
  const now = findStory(after, options.target, "after");
  const duplicates = [...duplicateKeyIssues(before, "before"), ...duplicateKeyIssues(after, "after")];
  const issues = [
    ...consistencyIssues(before, "before"),
    ...consistencyIssues(after, "after"),
    ...duplicates,
    ...targetIssues(was, now, options.target),
  ];
  if (duplicates.length === 0 && was.issue === undefined) {
    issues.push(...protectedIssues(before, after, was.story));
  }
  const target = now.story;
  if (target !== undefined) {
    issues.push(...textIssues(target, expected), ...rangeIssues(target, options.emojiFont));
  }
  return verdict(
    issues,
    {
      paragraphs: expected.length,
      protectedStories: before.length - (was.story ? 1 : 0),
      target: target ? storyKey(target) : options.target,
    },
    "Replaced story equals the selected text; protected stories are unchanged.",
    "Replaced story or protected stories do not match.",
    "Replace the whole intended story with the selected text, keep only exact emoji overrides, then read back and rerun story.",
  );
}
