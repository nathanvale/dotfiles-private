import { afterEach, describe, expect, test } from "bun:test";
import { utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, production, put, run, scratch, sha256, sourceRepository } from "./fixtures.ts";

afterEach(cleanup);

function expectRefused(result: ReturnType<typeof run>, ...fragments: string[]) {
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(3);
  expect(result.envelope.result.causeCode).toBe("DOMAIN_CHECK_FAILED");
  expect(result.envelope.result.data).toBeNull();
  for (const fragment of fragments) expect(result.envelope.message).toContain(fragment);
}

function expectPassed(result: ReturnType<typeof run>) {
  expect(result.stderr).toBe("");
  expect(result.envelope.message).not.toContain("issue(s)");
  expect(result.exitCode).toBe(0);
  expect(result.envelope.result.causeCode).toBe("SUCCESS_UNCHANGED");
}

describe("baseline: bind the build to the active native document", () => {
  function setup() {
    const dir = scratch();
    const art = put(dir, "B08-22.png", "art bytes");
    const copy = put(dir, "copy-resolution.json", "{}");
    const files = {
      capture: put(dir, "Cleaned-r11-live-baseline.indd", "r11 with concurrent frame repair"),
      r10: put(dir, "Phone-r10.indd", "r10 bytes"),
      r11: put(dir, "Phone-r11.indd", "r11 saved bytes"),
    };
    const live = put(dir, "live.json", { modified: true, page_count: 13, path: files.r11 });
    const binding = (baseline: unknown, artSha = sha256("art bytes")) =>
      put(dir, "binding.json", {
        art: [{ id: "B08-22", path: art, sha256: artSha }],
        baseline,
        chapter: "The Big Bad Phone",
        copyResolution: { path: copy, sha256: sha256("{}") },
        sourceRevision: sourceRepository(dir),
      });
    return { binding, files, live };
  }

  test("refuses a build bound to r10 while cleaned r11 is the active document", () => {
    const { binding, files, live } = setup();
    const bound = binding({ modified: false, pageCount: 13, path: files.r10, sha256: sha256("r10 bytes") });
    expectRefused(run("baseline", "--binding", bound, "--live", live), `build baseline ${files.r10} is not the active native document ${files.r11}`);
  });

  test("accepts the separately captured r11 baseline with its unsaved edits", () => {
    const { binding, files, live } = setup();
    const bound = binding({
      capture: { path: files.capture, sha256: sha256("r11 with concurrent frame repair") },
      modified: true,
      pageCount: 13,
      path: files.r11,
      sha256: sha256("r11 saved bytes"),
    });
    const result = run("baseline", "--binding", bound, "--live", live);
    expectPassed(result);
    expect((result.envelope.result.data as { baseline: { path: string } }).baseline.path).toBe(files.capture);
  });

  test("refuses unsaved live edits without a capture, and changed art", () => {
    const { binding, files, live } = setup();
    const bound = binding({ modified: true, pageCount: 13, path: files.r11, sha256: sha256("r11 saved bytes") }, sha256("old art"));
    expectRefused(run("baseline", "--binding", bound, "--live", live), "no separate baseline capture", "art B08-22");
  });
});

describe("protected: pages and typography survive the build", () => {
  const frame = (page: number, label: string, text: string, font = "Avenir Next\tRegular") => ({
    bounds: [58, 70, 110, 830],
    label,
    page,
    ranges: [{ font, size: 30, style: "Bestie Section Title", text }],
  });
  const before = [frame(1, "title", "The Big Bad Phone"), frame(2, "heading", "Before the call"), frame(3, "heading", "Press play")];

  test("flags a protected heading whose typography changed", () => {
    const dir = scratch();
    const after = [before[0], frame(2, "heading", "Before the call", "Noto Sans Coptic\tRegular"), before[2]];
    const result = run("protected", "--before", put(dir, "b.json", before), "--after", put(dir, "a.json", after), "--pages", "1-3");
    expectRefused(result, 'page 2→2: frame "heading" geometry, text or typography changed');
  });

  test("accepts a protected page moved by an inserted page", () => {
    const dir = scratch();
    const after = [before[0], frame(2, "heading", "New page"), frame(3, "heading", "Before the call"), { ...before[2], page: 4 }];
    const result = run("protected", "--before", put(dir, "b.json", before), "--after", put(dir, "a.json", after), "--pages", "1,2>3,3>4");
    expectPassed(result);
  });
});

describe("copy: resolve selected blocks and refuse stale build input", () => {
  const CHAPTER = [
    "## Holidays",
    "",
    "### Accepted introduction, locked copy",
    "",
    "They pack the car.",
    "",
    "They sit by the sea and feel reflective.",
    "",
    "### Accepted teaser, locked copy",
    "",
    "A week away together.",
    "",
    "### Selected ending",
    "",
    "They walk home.",
    "",
    "Nathan selects this ending with",
    '"yes".',
    "",
  ].join("\n");
  const MEMO = ["## Whole-book flow revision", "", "#### Holidays transition, selected", "", "They end on the hand.", "", "Standing note.", ""].join("\n");

  function setup() {
    const dir = scratch();
    const chapter = put(dir, "chapter-copy-proposals.md", CHAPTER);
    const memo = put(dir, "editorial-memorandum.md", MEMO);
    const accepted = { evidence: "fa1baf2", scope: "block" };
    const intro = { acceptance: accepted, heading: "Accepted introduction, locked copy", owner: chapter, paragraphs: [1, 2], role: "introduction", sha256: sha256("They pack the car.\n\nThey sit by the sea and feel reflective."), standing: "accepted" };
    const teaser = { acceptance: accepted, heading: "Accepted teaser, locked copy", owner: chapter, paragraphs: [1, 1], role: "teaser", sha256: sha256("A week away together."), standing: "accepted" };
    const ending = { acceptance: accepted, heading: "Selected ending", owner: chapter, paragraphs: [1, 1], role: "ending", sha256: sha256("They walk home."), standing: "selected" };
    const transition = {
      acceptance: { evidence: "editorial memo 11 October", scope: "block" },
      heading: "Holidays transition, selected",
      owner: memo,
      paragraphs: [1, 1],
      role: "transition",
      sha256: sha256("They end on the hand."),
      standing: "selected",
      supersedes: [{ heading: "Accepted introduction, locked copy", owner: chapter, paragraphs: [2, 2] }],
    };
    const resolution = (name: string, blocks: unknown[]) => put(dir, name, { blocks, chapter: "Holidays" });
    return { chapter, ending, intro, resolution, teaser, transition };
  }

  test("refuses older locked input when a newer selected transition lives in the editorial memo", () => {
    const { ending, intro, resolution, teaser, transition } = setup();
    const input = resolution("input.json", [intro, teaser, ending]);
    const current = resolution("current.json", [intro, teaser, ending, transition]);
    expectRefused(run("copy", "--input", input, "--current", current), "stale build input: current selected transition block", "editorial-memorandum.md#Holidays transition, selected");
  });

  test("accepts fresh input and composes the introduction with its selected transition", () => {
    const { ending, intro, resolution, teaser, transition } = setup();
    const current = resolution("current.json", [intro, teaser, ending, transition]);
    const result = run("copy", "--input", current, "--current", current);
    expectPassed(result);
    const placement = (result.envelope.result.data as { placement: { role: string; text: string; words: number }[] }).placement;
    expect(placement.map((p) => [p.role, p.text])).toEqual([
      ["introduction", "They pack the car.\n\nThey end on the hand."],
      ["teaser", "A week away together."],
      ["ending", "They walk home."],
    ]);
  });

  test("refuses a proposed block and an owner edit made after the input", () => {
    const { chapter, ending, intro, resolution, teaser } = setup();
    const proposed = { ...teaser, standing: "proposed" };
    const input = resolution("input.json", [intro, proposed, ending]);
    writeFileSync(chapter, CHAPTER.replace("They walk home.", "They walk home slowly."));
    expectRefused(run("copy", "--input", input, "--current", input), "only accepted or selected blocks can be placed", "owner text is now");
  });

  test("resolves a repeated copy heading inside its named chapter section", () => {
    const dir = scratch();
    const owner = put(dir, "chapter-copy-proposals.md", [
      "## The Big Bad Phone",
      "",
      "### Accepted introduction, locked copy",
      "",
      "They call.",
      "",
      "### Accepted teaser, locked copy",
      "",
      "The phone rings.",
      "",
      "## Holidays",
      "",
      "### Accepted introduction, locked copy",
      "",
      "They travel.",
      "",
      "### Accepted teaser, locked copy",
      "",
      "A week together.",
      "",
      "### Selected ending",
      "",
      "They return.",
      "",
    ].join("\n"));
    const acceptance = { evidence: "selected chapter copy", scope: "block" };
    const at = (role: string, heading: string, value: string) => ({
      acceptance,
      heading,
      owner,
      paragraphs: [1, 1],
      role,
      section: "Holidays",
      sha256: sha256(value),
      standing: "accepted",
    });
    const blocks = [
      at("introduction", "Accepted introduction, locked copy", "They travel."),
      at("teaser", "Accepted teaser, locked copy", "A week together."),
      at("ending", "Selected ending", "They return."),
    ];
    const scoped = put(dir, "scoped.json", { blocks, chapter: "Holidays" });
    expectPassed(run("copy", "--input", scoped, "--current", scoped));
    const ambiguous = put(dir, "ambiguous.json", {
      blocks: blocks.map(({ section: _section, ...rest }) => rest),
      chapter: "Holidays",
    });
    const result = run("copy", "--input", ambiguous, "--current", ambiguous);
    expect(result.exitCode).toBe(4);
    expect(result.envelope.message).toContain('2 headings named "Accepted introduction, locked copy"');
  });
});

describe("story: whole-story replacement with exact emoji overrides", () => {
  const plain = (text: string) => ({ font: "Avenir Next\tRegular", size: 20, style: "Bestie Body 20/28", text });
  const story = (label: string, text: string, ranges = [plain(text)]) => ({ label, ranges, text });
  const teaser = story("locked-teaser", "Phone calls are not their strong point.");
  const before = { stories: [story("locked-introduction", "Old one.\rOld two.\rOld overflow tail."), teaser] };

  function check(afterIntro: ReturnType<typeof story>, expected: string, protectedTeaser = teaser) {
    const dir = scratch();
    return run(
      "story",
      "--before", put(dir, "before.json", before),
      "--after", put(dir, "after.json", { stories: [afterIntro, protectedTeaser] }),
      "--target", "locked-introduction",
      "--expected", put(dir, "expected.txt", expected),
      "--emoji-font", "Apple Color Emoji\tRegular",
    );
  }

  test("refuses an old threaded tail left after the new paragraphs", () => {
    expectRefused(check(story("locked-introduction", "New one.\rNew two.\rOld overflow tail."), "New one.\n\nNew two.\n"), 'extra paragraph 3 "Old overflow tail."');
  });

  test("refuses a no-break space and a terminal space", () => {
    expectRefused(check(story("locked-introduction", "New one.\rNew two."), "New one.\n\nNew two.\n"), "paragraph 1 is \"New\\u00a0one.\"");
    expectRefused(check(story("locked-introduction", "New one.\rNew two. "), "New one.\n\nNew two.\n"), 'paragraph 2 is "New two. "');
  });

  test("accepts the exact story with an emoji-only font override", () => {
    const ranges = [plain("Love you "), { ...plain("😂"), font: "Apple Color Emoji\tRegular" }, plain("\rNew two.")];
    expectPassed(check(story("locked-introduction", "Love you 😂\rNew two.", ranges), "Love you 😂\n\nNew two.\n"));
  });

  test("refuses an inherited local font override and a changed protected story", () => {
    const ranges = [plain("New one.\r"), { ...plain("New two."), font: "Noto Sans Coptic\tRegular" }];
    const changedTeaser = story("locked-teaser", "Phone calls are hard.");
    expectRefused(check(story("locked-introduction", "New one.\rNew two.", ranges), "New one.\n\nNew two.\n", changedTeaser), "2 formatting variants", 'protected story "locked-teaser"');
  });
});

describe("story: page-keyed readbacks with repeated labels", () => {
  // Real Phone readbacks repeat heading, folio and running-footer on every page.
  const plain = (text: string) => ({ font: "Avenir Next\tDemi Bold", style: "Bestie Section Title", text });
  const at = (page: number, label: string, text: string) => ({ label, page, ranges: [plain(text)], text });
  const before = {
    stories: [
      at(1, "folio", "\u0018"),
      at(1, "running-footer", "THREE YEARS OF BESTIE"),
      at(2, "folio", "\u0018"),
      at(2, "running-footer", "THREE YEARS OF BESTIE"),
      at(2, "heading", "Before the first call"),
      at(3, "folio", "\u0018"),
      at(3, "running-footer", "THREE YEARS OF BESTIE"),
      at(3, "heading", "Old heading"),
      at(7, "heading", "The trophy line"),
    ],
  };
  const replaced = (changes: Record<string, string>) => ({
    stories: before.stories.map((s) => {
      const key = `p${s.page}:${s.label}`;
      return key in changes ? at(s.page, s.label, changes[key] as string) : s;
    }),
  });

  function check(after: unknown, target: string, beforeReadback: unknown = before) {
    const dir = scratch();
    return run(
      "story",
      "--before", put(dir, "before.json", beforeReadback),
      "--after", put(dir, "after.json", after),
      "--target", target,
      "--expected", put(dir, "expected.txt", "New heading\n"),
    );
  }

  test("accepts a page-qualified heading replacement while same-label stories on other pages stay unchanged", () => {
    const result = check(replaced({ "p3:heading": "New heading" }), "p3:heading");
    expectPassed(result);
    expect(result.envelope.result.data).toEqual({ paragraphs: 1, protectedStories: 8, target: "p3:heading" });
  });

  test("refuses a change to a same-label story on another page", () => {
    expectRefused(
      check(replaced({ "p3:heading": "New heading", "p7:heading": "The trophy line!" }), "p3:heading"),
      'protected story "p7:heading" text or formatting changed',
    );
  });

  test("fails closed on a bare label that names several stories", () => {
    expectRefused(
      check(replaced({ "p3:heading": "New heading" }), "heading"),
      'target "heading" is ambiguous in the before readback: p2:heading, p3:heading, p7:heading',
    );
  });

  test("fails closed when an unpaged readback repeats a label", () => {
    const unpaged = (r: typeof before) => ({ stories: r.stories.map(({ page: _page, ...s }) => s) });
    const after = replaced({ "p3:heading": "New heading" });
    expectRefused(
      check(unpaged(after), "p3:heading", unpaged(before)),
      'before readback has 3 stories keyed "heading"; add page to each story',
    );
  });
});

describe("geometry: footers, page numbers, backgrounds, role fonts and reply headers", () => {
  const CONTRACT = {
    backgroundLabels: ["background"],
    requiredBackgrounds: [] as { page: number; label: string }[],
    bleed: { bottom: 9, inside: 0, outside: 9, top: 9 },
    emojiFont: "Apple Color Emoji\tRegular",
    firstPageSide: "right",
    folio: { label: "folio", marker: "\u0018" },
    footer: {
      left: { folio: [710, 70, 735, 115], "running-footer": [710, 200, 735, 830] },
      right: { folio: [710, 785, 735, 830], "running-footer": [710, 70, 735, 700] },
    },
    footerExemptPages: [],
    replyHeader: {
      bodyStyles: ["Bestie Featured Message"],
      headerStyles: ["Bestie Message Header"],
      minGap: 6,
      pattern: "^(Nathan|Melanie) · \\d{1,2} [A-Z][a-z]+ \\d{4}( · \\d{1,2}:\\d{2}:\\d{2} [ap]m)?$",
    },
    styleFonts: { "Bestie Featured Message": "Georgia\tRegular", "Bestie Folio": "Avenir Next\tMedium", "Bestie Message Header": "Avenir Next\tMedium" },
    tolerance: 0.5,
    trim: { height: 765, width: 900 },
  };
  const folioRange = { font: "Avenir Next\tMedium", style: "Bestie Folio", text: "\u0018" };
  const footerRange = { font: "Avenir Next\tMedium", style: "Bestie Folio", text: "THREE YEARS OF BESTIE" };
  const footers = (page: number) => {
    const side = page % 2 === 1 ? CONTRACT.footer.right : CONTRACT.footer.left;
    return [
      { bounds: side.folio, label: "folio", page, ranges: [folioRange] },
      { bounds: side["running-footer"], label: "running-footer", page, ranges: [footerRange] },
    ];
  };
  const bg = (page: number, kind: string, bounds: number[]) => ({ bounds, fill: "Bestie Cream", kind, label: "background", page, ranges: [] });

  function check(frames: unknown[], contract = CONTRACT) {
    const dir = scratch();
    return run("geometry", "--snapshot", put(dir, "format.json", frames), "--contract", put(dir, "contract.json", contract));
  }

  test("fails when a required opener background is missing from the readback", () => {
    const contract = {
      ...CONTRACT,
      requiredBackgrounds: [{ page: 1, label: "background" }],
    };
    expectRefused(
      check(footers(1), contract),
      'p1 has 0 required background "background" frames; expected 1.',
    );
    expectPassed(check([...footers(1), bg(1, "textFrame", [-9, 0, 774, 909])], contract));
  });

  test("fails white bleed for rectangle and empty text-frame backgrounds on recto and verso", () => {
    const trim = [0, 0, 765, 900];
    const frames = [1, 2, 3, 4].flatMap((p) => footers(p));
    frames.push(bg(1, "rectangle", trim), bg(2, "rectangle", trim), bg(3, "textFrame", trim), bg(4, "textFrame", trim));
    expectRefused(
      check(frames),
      "p1 background (rectangle) [0, 0, 765, 900] leaves white bleed at top, bottom, right",
      "p2 background (rectangle) [0, 0, 765, 900] leaves white bleed at top, bottom, left",
      "p3 background (textFrame) [0, 0, 765, 900] leaves white bleed at top, bottom, right",
      "p4 background (textFrame) [0, 0, 765, 900] leaves white bleed at top, bottom, left",
    );
  });

  test("accepts backgrounds that reach bleed and stop at the binding, whatever their class", () => {
    const frames = [1, 2].flatMap((p) => footers(p));
    frames.push(bg(1, "textFrame", [-9, 0, 774, 909]), bg(2, "rectangle", [-9, -9, 774, 900]));
    const result = check(frames);
    expectPassed(result);
    expect((result.envelope.result.data as { backgroundsChecked: unknown[] }).backgroundsChecked).toEqual([
      { kind: "textFrame", label: "background", page: 1 },
      { kind: "rectangle", label: "background", page: 2 },
    ]);
  });

  test("fails a background that crosses the binding edge", () => {
    expectRefused(check([...footers(1), bg(1, "rectangle", [-9, -9, 774, 909])]), "p1 background (rectangle) extends across the binding edge");
  });

  test("fails drifted footers, a hidden page number and a covered footer", () => {
    const [folio, footer] = footers(3) as unknown as [Record<string, unknown>, Record<string, unknown>];
    const frames = [
      { ...folio, bounds: [710, 776, 735, 821], ranges: [{ ...folioRange, text: "3" }] },
      footer,
      { ...footers(4)[0], visible: false },
      footers(4)[1],
      { bounds: [600, 70, 720, 830], label: "art-B08-23", page: 4, ranges: [] },
    ];
    expectRefused(
      check(frames),
      "p3 folio at [710, 776, 735, 821]; contract right page expects [710, 785, 735, 830]",
      "p3 folio lacks the automatic page-number marker",
      "p4 folio is hidden",
      'p4 running-footer is overlapped by "art-B08-23"',
    );
  });

  const header = (label: string, bounds: number[], text: string, ink?: number[], inkMethod?: string) => ({
    bounds,
    label,
    page: 1,
    ranges: [{ font: "Avenir Next\tMedium", style: "Bestie Message Header", text }],
    ...(ink ? { ink } : {}),
    ...(inkMethod ? { inkMethod } : {}),
  });
  const body = (label: string, bounds: number[], font: string, ink?: number[], inkMethod?: string) => ({
    bounds,
    label,
    page: 1,
    ranges: [{ font, style: "Bestie Featured Message", text: "Example reply for a layout check." }],
    ...(ink ? { ink } : {}),
    ...(inkMethod ? { inkMethod } : {}),
  });

  test("fails a rendered reply collision, a header without date, mojibake, and a role-font override", () => {
    const frames = [
      ...footers(1),
      header("header-0", [152, 70, 182, 830], "Melanie · 13 May 2025 · 6:15:04 pm"),
      body("body-0", [192, 70, 360, 830], "Georgia\tRegular", [194, 70, 358, 600], "raster-glyph"),
      header("header-1", [356, 70, 386, 830], "Nathan · 13 May 2025 · 6:17:00 pm", [360, 70, 380, 400], "glyph-outline"),
      body("body-1", [396, 70, 430, 830], "Noto Sans Coptic\tRegular"),
      header("mobile-invitation-sender", [440, 70, 470, 830], "Melanie"),
      header("encoded-sender", [500, 70, 530, 830], "Melanie ¬∑ 11 October 2026 ¬∑ 5:58:22 pm"),
    ];
    expectRefused(
      check(frames),
      'p1 header "header-1" and body "body-0" rendered text is 2pt apart; minimum 6pt',
      'p1 header "mobile-invitation-sender" text "Melanie" does not match the header pattern',
      'p1 header "encoded-sender" text "Melanie ¬∑ 11 October 2026 ¬∑ 5:58:22 pm" does not match',
      'p1 body-1 uses "Noto Sans Coptic\\tRegular"; style "Bestie Featured Message" declares "Georgia\\tRegular"',
    );
  });
  // Phone r17 page 7 as read back: frames, plus ink measured two ways from the
  // review PDF (t-0175). Font boxes come from pdftotext word bounds; raster rows
  // from the 288 dpi render. Message text here is placeholder.
  const PHONE_P7: [string, number[], number[], number[]][] = [
    ["source-meta-E-MELANIE", [110, 105, 140, 795], [106.4, 105, 135.8, 408], [114.2, 105, 132.5, 408]],
    ["source-body-E-MELANIE", [150, 105, 235, 795], [146.2, 105, 178.2, 422.5], [154.5, 105, 175, 422.5]],
    ["source-meta-F-MELANIE", [245, 105, 275, 795], [241.4, 105, 270.8, 456.8], [249.2, 105, 267.5, 456.8]],
    ["source-body-F-MELANIE", [285, 105, 370, 795], [281.2, 105, 313.2, 706.4], [289.5, 105, 310, 706.4]],
    ["source-meta-F-NATHAN", [355, 105, 385, 795], [351.4, 105, 380.8, 450.5], [359.2, 105, 377.5, 450.5]],
    ["source-body-F-NATHAN", [395, 105, 460, 795], [375.8, 105, 427.7, 165], [395.5, 105, 415.5, 165]],
    ["source-meta-H-MELANIE", [440, 105, 470, 795], [436.4, 105, 465.8, 460.8], [444.2, 105, 462.5, 460.8]],
    ["source-body-H-MELANIE", [480, 105, 565, 795], [476.2, 105, 536.2, 788.1], [484.8, 105, 528.2, 788.1]],
    ["source-meta-H-NATHAN", [560, 105, 590, 795], [556.4, 105, 585.8, 454.4], [564.2, 105, 582.5, 454.4]],
    ["source-body-H-NATHAN", [600, 105, 685, 795], [596.2, 105, 656.2, 787.7], [604.5, 105, 653, 787.7]],
  ];
  // Phone r13 page 9 before the r14 spacing repair: a visibly crowded reply.
  // Only raster rows were measured here; the word-box column restates the frame.
  const CROWDED_P9: [string, number[], number[], number[]][] = [
    ["curated-meta-0", [103, 88, 133, 812], [103, 88, 133, 489.9], [107.2, 88, 125.5, 489.9]],
    ["curated-body-0", [143, 88, 207, 812], [143, 88, 207, 493], [142.8, 88, 206.5, 493]],
    ["curated-meta-1", [205, 88, 235, 812], [205, 88, 235, 483.6], [201.2, 88, 227.5, 483.6]],
    ["curated-body-1", [245, 88, 280, 812], [245, 88, 280, 97], [249.2, 88, 260.8, 97]],
  ];
  const PHONE = { ...CONTRACT, replyHeader: { ...CONTRACT.replyHeader, bodyStyles: ["Bestie Featured Message"], minGap: 10 } };

  function measured(page: number, rows: typeof PHONE_P7, use: "font" | "raster", inkMethod: string | undefined) {
    return rows.map(([label, bounds, fontBox, raster]) => {
      const ink = use === "font" ? fontBox : raster;
      const frame = label.includes("-meta-")
        ? header(label, bounds, "Nathan · 20 November 2025 · 8:34:54 pm", ink, inkMethod)
        : body(label, bounds, "Georgia\tRegular", ink, inkMethod);
      return { ...frame, page };
    });
  }
  const review = (result: ReturnType<typeof run>) => (result.envelope.result.data as { containerReview: string[] }).containerReview;

  test("passes the Phone page 7 reference when raster glyph ink proves the overlapping frames clear", () => {
    const result = check([...footers(7), ...measured(7, PHONE_P7, "raster", "raster-glyph")], PHONE);
    expectPassed(result);
    expect(review(result)).toEqual([]);
    const provenance = (result.envelope.result.data as { inkProvenance: { glyphTight: boolean; method: string }[] }).inkProvenance;
    expect(provenance).toHaveLength(10);
    expect(provenance.every((p) => p.glyphTight && p.method === "raster-glyph")).toBe(true);
  });

  test("never fails the Phone page 7 reference on PDF word-box ink; overlaps go to review", () => {
    const result = check([...footers(7), ...measured(7, PHONE_P7, "font", "pdf-word-box")], PHONE);
    expectPassed(result);
    expect(review(result)).toEqual([
      'p7 header "source-meta-F-NATHAN" and body "source-body-F-MELANIE" frames are -15pt apart; ink from pdf-word-box is not glyph-tight, so it cannot decide a collision. Review at useful scale or supply raster-glyph or glyph-outline ink.',
      'p7 header "source-meta-H-MELANIE" and body "source-body-F-NATHAN" frames are -20pt apart; ink from pdf-word-box is not glyph-tight, so it cannot decide a collision. Review at useful scale or supply raster-glyph or glyph-outline ink.',
      'p7 header "source-meta-H-NATHAN" and body "source-body-H-MELANIE" frames are -5pt apart; ink from pdf-word-box is not glyph-tight, so it cannot decide a collision. Review at useful scale or supply raster-glyph or glyph-outline ink.',
    ]);
  });

  test("treats ink without a named method as unqualified", () => {
    const result = check([...footers(7), ...measured(7, PHONE_P7, "font", undefined)], PHONE);
    expectPassed(result);
    expect(review(result)).toHaveLength(3);
    expect(review(result)[0]).toContain("ink from an unnamed method is not glyph-tight");
  });

  test("fails the crowded r13 page 9 reply on raster glyph ink, and only reviews it on word boxes", () => {
    expectRefused(
      check([...footers(9), ...measured(9, CROWDED_P9, "raster", "raster-glyph")], PHONE),
      'p9 header "curated-meta-1" and body "curated-body-0" rendered text is -5.3pt apart; minimum 10pt.',
    );
    const unqualified = check([...footers(9), ...measured(9, CROWDED_P9, "font", "pdf-word-box")], PHONE);
    expectPassed(unqualified);
    expect(review(unqualified)).toEqual([
      'p9 header "curated-meta-1" and body "curated-body-0" frames are -2pt apart; ink from pdf-word-box is not glyph-tight, so it cannot decide a collision. Review at useful scale or supply raster-glyph or glyph-outline ink.',
    ]);
  });

  test("passes a container-only overlap without ink but asks for useful-scale review", () => {
    const frames = [
      ...footers(1),
      body("body-0", [192, 70, 360, 830], "Georgia\tRegular"),
      header("header-1", [356, 70, 386, 830], "Nathan · 13 May 2025 · 6:17:00 pm"),
    ];
    const result = check(frames);
    expectPassed(result);
    expect(review(result)).toEqual([
      'p1 header "header-1" and body "body-0" frames are -4pt apart without glyph-tight ink. Review at useful scale or supply raster-glyph or glyph-outline ink.',
    ]);
  });

  test("keeps review flags in the failure message when another check fails", () => {
    const [folio, footer] = footers(1) as unknown as [Record<string, unknown>, Record<string, unknown>];
    const frames = [
      { ...folio, bounds: [696.5, 785, 721.5, 830] },
      footer,
      body("body-0", [192, 70, 360, 830], "Georgia\tRegular"),
      header("header-1", [356, 70, 386, 830], "Nathan · 13 May 2025 · 6:17:00 pm"),
    ];
    expectRefused(
      check(frames),
      "1 issue(s): 1) p1 folio at [696.5, 785, 721.5, 830]",
      'Also review 1 flag(s): a) p1 header "header-1" and body "body-0" frames are -4pt apart without glyph-tight ink.',
    );
  });
});

describe("dispatch: native-control duplicate guard against operation receipts", () => {
  const NOW = "2026-10-11T22:00:00+11:00";
  const at = (iso: string) => new Date(iso);

  test("refuses an operation folder that already has completed.txt", () => {
    const dir = scratch();
    put(dir, "started.txt", "Selected opener text integration started");
    put(dir, "completed.txt", "Fifteen pages saved, reopened, exported.");
    expectRefused(run("dispatch", "--receipts", dir, "--now", NOW), `already completed: ${join(dir, "completed.txt")}`);
  });

  test("refuses a bare completed.txt even when an operation name is supplied", () => {
    const dir = scratch();
    put(dir, "completed.txt", "done");
    expectRefused(run("dispatch", "--receipts", dir, "--operation", "apply-r16", "--now", NOW), "already completed");
  });

  test("still honours the older prefixed receipt spelling", () => {
    const dir = scratch();
    put(dir, "phaseA-repair-r2-completed.txt", "done");
    expectRefused(run("dispatch", "--receipts", dir, "--operation", "phaseA-repair-r2", "--now", NOW), "phaseA-repair-r2-completed.txt");
  });

  test("refuses prefixed receipts without their operation name", () => {
    const dir = scratch();
    put(dir, "phaseA-completed.txt", "done");
    expectRefused(run("dispatch", "--receipts", dir, "--now", NOW), "receipt folder contains named operations: phaseA-completed.txt");
  });

  test("asks for a bounded wait while a fresh started receipt settles", () => {
    const dir = scratch();
    const started = put(dir, "started.txt", "started");
    utimesSync(started, at("2026-10-11T21:59:50+11:00"), at("2026-10-11T21:59:50+11:00"));
    const result = run("dispatch", "--receipts", dir, "--now", NOW);
    expect(result.exitCode).toBe(75);
    expect(result.envelope.result.causeCode).toBe("TRANSIENT_NOT_STARTED");
    expect(result.envelope.result.retryable).toBe(true);
    expect(result.envelope.result.retryDelayMilliseconds).toBe(20_000);
  });

  test("reports a named operation's own unfinished start before a bare folder completion", () => {
    const dir = scratch();
    put(dir, "completed.txt", "done");
    put(dir, "edge-cleanup-started.txt", "started");
    put(dir, "edge-cleanup-completed.txt", "done");
    const started = put(dir, "recovery2-started.txt", "started");
    utimesSync(started, at("2026-10-11T21:50:00+11:00"), at("2026-10-11T21:50:00+11:00"));
    expectRefused(
      run("dispatch", "--receipts", dir, "--operation", "recovery2", "--now", NOW),
      "Operation recovery2 has an uncertain outcome",
      `started without completing: ${join(dir, "recovery2-started.txt")}`,
      `bare ${join(dir, "completed.txt")} does not name this operation`,
    );
    expectRefused(
      run("dispatch", "--receipts", dir, "--operation", "edge-cleanup", "--now", NOW),
      `already completed: ${join(dir, "edge-cleanup-completed.txt")}`,
    );
  });

  test("reports an uncertain outcome for an old started receipt without completion", () => {
    const dir = scratch();
    const started = put(dir, "started.txt", "started");
    utimesSync(started, at("2026-10-11T21:50:00+11:00"), at("2026-10-11T21:50:00+11:00"));
    expectRefused(run("dispatch", "--receipts", dir, "--now", NOW), "uncertain outcome");
  });

  test("refuses a named error receipt: the r11 voice-section build failed with an uncertain effect", () => {
    // Real r11-voice-section shape: build errored; other operations completed or errored.
    const dir = scratch();
    put(dir, "build-error.txt", "ReferenceError: s.charCodeAt is not a function line 18");
    put(dir, "capture-completed.txt", "captured");
    put(dir, "repair-completed.txt", "repaired");
    put(dir, "emoji-repair-error.txt", "emoji repair failed");
    const fresh = put(dir, "target.json", { capturedAt: "2026-10-11T21:59:30+11:00" });
    expectRefused(
      run("dispatch", "--receipts", dir, "--operation", "build", "--target", fresh, "--now", NOW),
      "Operation build recorded an error; its effect is uncertain",
      `operation "build" recorded an error: ${join(dir, "build-error.txt")}`,
    );
    expectRefused(
      run("dispatch", "--receipts", dir, "--target", fresh, "--now", NOW),
      "receipt folder contains named operations: build-error.txt, capture-completed.txt, emoji-repair-error.txt, repair-completed.txt",
    );
  });

  test("refuses a bare error.txt with or without an operation name", () => {
    const dir = scratch();
    put(dir, "error.txt", "failed");
    const fresh = put(dir, "target.json", { capturedAt: "2026-10-11T21:59:30+11:00" });
    expectRefused(run("dispatch", "--receipts", dir, "--target", fresh, "--now", NOW), `recorded an error: ${join(dir, "error.txt")}`);
    expectRefused(run("dispatch", "--receipts", dir, "--operation", "apply-r18", "--target", fresh, "--now", NOW), `recorded an error: ${join(dir, "error.txt")}`);
  });

  test("clears a new named operation beside other operations' receipts with a fresh target", () => {
    const dir = scratch();
    const capture = put(dir, "capture-completed.txt", "captured");
    utimesSync(capture, at("2026-10-11T21:40:00+11:00"), at("2026-10-11T21:40:00+11:00"));
    const fresh = put(dir, "target.json", { capturedAt: "2026-10-11T21:59:30+11:00" });
    expectRefused(run("dispatch", "--receipts", dir, "--operation", "build-r2", "--now", NOW), "fresh accessibility target is required");
    expectPassed(run("dispatch", "--receipts", dir, "--operation", "build-r2", "--target", fresh, "--now", NOW));
  });

  test("clears an empty folder with a fresh target and refuses a stale one", () => {
    const dir = scratch();
    expectRefused(run("dispatch", "--receipts", dir, "--now", NOW), "fresh accessibility target is required");
    const fresh = put(dir, "target-fresh.json", { capturedAt: "2026-10-11T21:59:30+11:00" });
    expectPassed(run("dispatch", "--receipts", dir, "--target", fresh, "--now", NOW));
    const stale = put(dir, "target-stale.json", { capturedAt: "2026-10-11T21:50:00+11:00" });
    expectRefused(run("dispatch", "--receipts", dir, "--target", stale, "--now", NOW), "accessibility target is 600s old");
  });
});

describe("handback: one current revision whose claims match evidence", () => {
  const PDF = "%PDF-1.4\n1 0 obj << /Type /Pages /Count 2 >> endobj\n2 0 obj << /Type /Page >> endobj\n3 0 obj << /Type /Page >> endobj\n%%EOF\n";
  const SELECTED = "They find their way to each other.";
  const OLDER = "They find their way to each other, again and again, by phone.";

  function setup(nativeIntro: string) {
    const dir = scratch();
    const owner = put(dir, "chapter-copy-proposals.md", `### Accepted introduction, locked copy\n\n${SELECTED}\n`);
    const accepted = { evidence: "e783b22", scope: "block" };
    const block = { acceptance: accepted, heading: "Accepted introduction, locked copy", owner, paragraphs: [1, 1], sha256: sha256(SELECTED), standing: "accepted" };
    const resolution = put(dir, "copy-resolution.json", {
      blocks: [{ ...block, role: "introduction" }, { ...block, role: "teaser" }, { ...block, role: "ending" }],
      chapter: "The Big Bad Phone",
    });
    const stories = put(dir, "stories.json", { stories: [{ label: "locked-introduction", ranges: [{ text: nativeIntro }], text: nativeIntro }] });
    const record = (overrides: Record<string, unknown>) => {
      const native = { path: put(dir, "r16.indd", "indd bytes"), sha256: sha256("indd bytes") };
      const pdf = { path: put(dir, "r16.pdf", PDF), sha256: sha256(PDF) };
      return put(dir, "handback.json", {
        ...production(dir, "review-pdf", native, pdf, 2),
        chapter: "The Big Bad Phone",
        copy: [{ role: "introduction", standing: "pending-placement", storyLabel: "locked-introduction" }],
        copyResolution: resolution,
        nativeStories: stories,
        native,
        nextAction: "Nathan reviews page 2 at useful scale.",
        pageCount: 2,
        pdf,
        preview: { queuedAt: "2026-10-11T22:10:00+11:00", state: "queued" },
        revision: "r16",
        sourceExtents: [{ extent: "excerpt", key: "example_message_001", page: 2 }],
        ui: { owner: "foreground Desktop", released: true },
        writingBeats: { open: [], selected: [{ answer: "option 1", evidence: "i meant 1 not 2", question: "Q9 teaser" }] },
        ...overrides,
      });
    };
    return { record };
  }

  test("refuses pending newer copy reported as placed", () => {
    const { record } = setup(OLDER);
    const path = record({ copy: [{ role: "introduction", standing: "placed", storyLabel: "locked-introduction" }] });
    expectRefused(run("handback", "--record", path), 'introduction is reported placed, but native "locked-introduction" (12 words) differs from the selected manuscript (7 words)');
  });

  test("refuses a queued preview reported as viewed", () => {
    const { record } = setup(OLDER);
    const path = record({ preview: { queuedAt: "2026-10-11T22:10:00+11:00", state: "viewed" } });
    expectRefused(run("handback", "--record", path), "preview is reported viewed, but its evidence proves only queued");
  });

  test("accepts an honest handback and reports native and manuscript standings", () => {
    const { record } = setup(OLDER);
    const result = run("handback", "--record", record({}));
    expectPassed(result);
    const data = result.envelope.result.data as { pageCount: number; copy: { standing: string; nativeWords: number; manuscriptWords: number }[] };
    expect(data.pageCount).toBe(2);
    expect(data.copy).toEqual([expect.objectContaining({ manuscriptWords: 7, nativeWords: 12, standing: "pending-placement" })]);
  });

  test("addresses a repeated native story label by page and refuses a bare ambiguous label", () => {
    const { record } = setup(OLDER);
    const dir = scratch();
    const at = (page: number, text: string) => ({ label: "locked-introduction", page, ranges: [{ text }], text });
    const nativeStories = put(dir, "paged-stories.json", { stories: [at(2, OLDER), at(9, SELECTED)] });
    const copy = (storyLabel: string) => [{ role: "introduction", standing: "pending-placement", storyLabel }];
    expectRefused(
      run("handback", "--record", record({ copy: copy("locked-introduction"), nativeStories })),
      'copy role introduction story target "locked-introduction" is ambiguous in the native story readback: p2:locked-introduction, p9:locked-introduction.',
    );
    expectPassed(run("handback", "--record", record({ copy: copy("p2:locked-introduction"), nativeStories })));
  });

  test("refuses a wrong page count and a Writing Beats question both selected and open", () => {
    const { record } = setup(SELECTED);
    const path = record({
      copy: [{ role: "introduction", standing: "placed", storyLabel: "locked-introduction" }],
      pageCount: 3,
      writingBeats: { open: [{ question: "Q9 teaser" }], selected: [{ answer: "option 1", evidence: "i meant 1 not 2", question: "Q9 teaser" }] },
    });
    expectRefused(run("handback", "--record", path), "handback reports 3 pages; the PDF has 2", 'question "Q9 teaser" is both selected and open');
  });
});
