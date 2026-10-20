import type { BookContract, BookReadback } from "./book-input.ts";
import { copyParagraphs } from "./copy.ts";
import { sha256Text } from "./input.ts";

/** Paragraphs of each heading section; a heading line is a boundary, never part of a paragraph. */
function sectionParagraphs(text: string): string[][] {
  return text.split(/^#{1,6}\s.*$/m).map(copyParagraphs);
}

function sourceAt(book: BookReadback, owner: string): string | null {
  const { repository, commit } = book.sourceRevision;
  const run = Bun.spawnSync(["git", "-C", repository, "show", `${commit}:${owner}`], { stderr: "ignore", stdin: "ignore", stdout: "pipe" });
  return run.exitCode === 0 ? run.stdout.toString() : null;
}

function containsRun(sections: string[][], run: string[]): boolean {
  if (run.length === 0) return false;
  return sections.some((source) => source.some((_, start) => run.every((paragraph, i) => source[start + i] === paragraph)));
}

/** Binds each story's expected text to the contract's digest and to the bound source revision. */
export function sourceIssues(book: BookReadback, contract: BookContract): string[] {
  return book.stories.flatMap((story) => {
    const declared = contract.stories.find((s) => s.key === story.key);
    if (declared === undefined) return [];
    const issues: string[] = [];
    const digest = sha256Text(story.expected);
    if (digest !== declared.sha256) issues.push(`story ${story.key} expected text is ${digest}, not the contract's selected ${declared.sha256}.`);
    const source = sourceAt(book, declared.owner);
    if (source === null) return [...issues, `story ${story.key} owner ${declared.owner} is not in source revision ${book.sourceRevision.commit}.`];
    if (!containsRun(sectionParagraphs(source), story.expected.split("\r"))) issues.push(`story ${story.key} expected text is not paragraph-for-paragraph in ${declared.owner} at ${book.sourceRevision.commit}.`);
    return issues;
  });
}
