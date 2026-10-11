import { type CheckResult, verdict } from "./check-result.ts";
import {
  anyText,
  type JsonRecord,
  list,
  readJson,
  readText,
  record,
  text,
} from "./input.ts";

/** One native story: its whole contents (including overset) and style ranges. */
export type Story = { label: string; text: string; ranges: JsonRecord[] };

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
  return {
    label: text(item.label, `${where}.label`),
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
        `story "${target.label}" has an extra paragraph ${index + 1} ${visible(got ?? "")} (old tail?).`,
      ];
    }
    return [
      `story "${target.label}" paragraph ${index + 1} is ${visible(got ?? "<missing>")}; expected ${visible(want)}.`,
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
        `story "${target.label}" range ${visible(value)} mixes emoji with other text or lacks the emoji font.`,
      );
    } else if (emojiFontRange && !emoji) {
      issues.push(
        `story "${target.label}" range ${visible(value)} has the emoji font but no emoji.`,
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
        `story "${target.label}" style "${style}" carries ${variants.size} formatting variants; clear inherited local overrides.`,
      );
    }
  }
  return issues;
}

function consistencyIssues(stories: Story[], label: string): string[] {
  return stories.flatMap((s) =>
    s.ranges.map((r) => String(r.text)).join("") === s.text
      ? []
      : [`${label} story "${s.label}" ranges do not reproduce its text.`],
  );
}

function protectedIssues(before: Story[], after: Story[], target: string): string[] {
  const now = new Map(after.map((s) => [s.label, JSON.stringify(s)]));
  return before
    .filter((s) => s.label !== target)
    .flatMap((s) => {
      const after = now.get(s.label);
      if (after === undefined) return [`protected story "${s.label}" was removed.`];
      return after === JSON.stringify(s)
        ? []
        : [`protected story "${s.label}" text or formatting changed.`];
    });
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
  const target = after.find((s) => s.label === options.target);
  const issues = [
    ...consistencyIssues(before, "before"),
    ...consistencyIssues(after, "after"),
    ...protectedIssues(before, after, options.target),
  ];
  if (target === undefined) {
    issues.push(`after readback has no story "${options.target}".`);
  } else {
    issues.push(...textIssues(target, expected), ...rangeIssues(target, options.emojiFont));
  }
  return verdict(
    issues,
    {
      paragraphs: expected.length,
      protectedStories: before.length - 1,
      target: options.target,
    },
    "Replaced story equals the selected text; protected stories are unchanged.",
    "Replaced story or protected stories do not match.",
    "Replace the whole intended story with the selected text, keep only exact emoji overrides, then read back and rerun story.",
  );
}
