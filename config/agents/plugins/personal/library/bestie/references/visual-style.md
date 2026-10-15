# Bestie storybook visual contract

Read this guide before every Bestie meme brief, generation, edit or review. Use
first glimpse as the primary drawing treatment. Nathan selected it on 11 October
2026 for Three Years of Bestie. Style approval does not approve a concept,
caption or artwork version.

## Authority

| Decision | Owner | Apply it to |
| --- | --- | --- |
| Current choices and corrections | Nathan's explicit instructions | The named task and artwork |
| Event, people, outfits, props, scene, panel sequence, action, exact caption and joke | The bound source, subject to Nathan's choices | Story content |
| Drawing treatment | [First glimpse](../assets/style-references/first-glimpse-storybook-r2.jpg) | Characters and settings |
| Caption weight | [Approved C](../assets/style-references/caption-weight-c-approved.png) | Lettering only |
| Frame family | Column A of the [original comparison](comic-frames-original-comparison.png), with Nathan's corrections below | Caption, speech, thought and sound frames |
| Page composition | The book's current design system and creative-director skill | InDesign layout |
| Individual artwork acceptance | Nathan's approval and the book's artwork-selection note | Accepted versions and reference additions |

Use drawing references for treatment. Preserve first-meeting clothes within
that scene unless Nathan extends them to another. A thought frame does not
authorize an invented memory or motive.

## Prepare the brief

1. Bind the source, target version, chosen concept, exact caption and authorized
   changes. Preserve accepted decisions and unrelated scene details.
2. View first glimpse and C. For generation, pass the clean first-glimpse drawing
   to the image tool. For an edit, include the actual target too. View frame A
   when frames appear. If a reference is unavailable, report its path, follow
   the written rule, and leave that visual comparison unverified.
3. Include the applicable character and dog facts below.
4. Establish the intended book placement when available. Request the largest
   native image the selected route actually supports, preserving the artwork's
   aspect ratio and whole composition. Keep the returned production master.

Follow the Bestie skill for concept and generation authority. Report route
limitations; obtain Nathan's spending approval before switching to a paid API.

## Drawing and identity

Draw a warm, hand-drawn 2D storybook cartoon. Use bold, slightly irregular dark
ink outlines, small expressive oval eyes, rounded faces, flat matte colour
shapes, simple shadows and subtle printed-paper grain. Use the same treatment for settings. Keep action, panel sequence and wording easy
to read.

Use the book palette below while preserving scene colours. Keep skin and fabric
stylized and matte.

Draw Nathan with a fully shaved, smooth skin-coloured scalp and a clean-shaven
face, as he confirmed on 11 October 2026. Preserve his blue eyes when iris
detail appears. Inspect every Nathan figure for a hairline, scalp stubble,
sideburns or a sharply bounded dark scalp patch that could read as hair.

Preserve Melanie's established black ponytail unless Nathan requests a change.
Keep appearance and proportions consistent across scene and expression edits.

When a dog appears, brief and inspect its owner, breed, size and colour against
these facts, confirmed on 11 October 2026:

- Melanie's dog is a medium-sized black cavoodle.
- Nathan's dog is a small white bichon frise.

Melanie's black cavoodle overrides brown dogs in older references.

## Caption C

Use rounded regular lettering matching C, approved on 13 October 2026. Keep
scene ink governed by first glimpse. C's headline uses Chalkboard Regular at a
nominal 90 pixels. Its uppercase I measures 61 pixels high, with an 8-pixel
central stem at 50 percent ink coverage. Other glyph strokes vary.

Keep representative straight stems between 12 and 14 percent of actual capital
height, targeting 13 percent. The reference headline stem is about 8 pixels,
or `8 * output_width / 1254` when scaling the whole image. Scale smaller
caption stems with their own capital height. Keep stem thickness separate
from total line width and fit.

Measure the delivered lettering at native output size. Sample at least three
straight stems away from joins and rounded terminals at 50 percent ink coverage.
Each representative sample must meet the range. Record sampled glyphs and pixel
locations, measurement method, capital height, stem widths and image dimensions. Check exact wording
and readability at intended placement. Correct out-of-range lettering before
approval. A prompt does not prove delivered lettering.

## Frame A

Use the soft and simple family A, approved on 13 October 2026. Use warm cream fill, rounded shapes and a thin, gently irregular dark single
border. Inset whole lettering comfortably. Use this family across the book:

- Put captions in softly rounded rectangular plaques.
- Put speech in rounded balloons with a curved pointed tail aimed at the speaker.
- Put thoughts in soft cloud-shaped balloons with progressively smaller round
  dots leading toward the thinker.
- Put sound effects in modest soft cloud frames.

Omit decorative olive branches and sprigs from captions and bubbles, including
those in references. Keep restrained emphasis rays for speech or sound effects
where useful, small and clear of lettering. Use a single border without drop
shadows. The [thought-bubble example](comic-frames-soft-simple.png) supplies the
cloud and trailing dots. Keep the outline, tail and thought dots visible at
final placement. C governs the lettering in every frame.

## Book colour

For a requested transparent background, use the
[transparent-background workflow](transparent-backgrounds.md) so the page colour
shows through the outer field while the illustration keeps its intended fills.

Use this palette for new or explicitly authorized revised memes, as Nathan
requested on 13 October 2026 for harmony with the Kate Berry-inspired InDesign
pages. Retain storybook line art, caption C and frame A.

| Page colour | CMYK percentages | Illustration role |
| --- | --- | --- |
| Bestie Cream | 0, 1, 7, 0 | Caption plaques and quiet pale backgrounds |
| Bestie Mint | 13, 0, 7, 0 | Pale open space and light background accents |
| Bestie Blush | 0, 12, 8, 0 | Small warm background areas and affectionate accents |
| Bestie Coral | 0, 65, 55, 0 | Restrained accent details |
| Bestie Green | 52, 0, 26, 10 | Supporting accent details |

These values come from actual Holidays r7 and Phone r18 PDF page content. They
are not claimed as Kate's original swatch definitions. Match appearance against
a colour-managed render of the current chapter. CMYK values depend on the
output profile. Generated RGB artwork and approximate screen hex values do not
prove a print colour match.

Keep large background areas pale and matte beside cream, mint or blush pages.
Preserve recognizable skin, clothing, water and night colours and the scene's
lighting. Use navy, muted blue, amber and wood tones where the scene needs them.
Use flat shading and restrained grain, with stronger coral and green confined
to small accents. Keep captions dark on cream.

Review the whole meme beside its intended page background before acceptance.
This direction does not authorize recolouring all existing memes or changing
native page swatches. Final placement, image quality and production colour
proof remain separate checks.

## Production masters and input references

Preserve the largest actual native output as the production master. Inspect
its dimensions and record effective PPI at the intended placement when known.
Report unknown placement or inadequate resolution as a proof gap. Requested
dimensions, resized pixels and changed DPI metadata do not prove native detail.
General upscaling remains outside this task.

OpenAI's [image generation documentation](https://developers.openai.com/api/docs/guides/image-generation),
checked on 13 October 2026, gives GPT Image 2 and 2.5 API generation these
limits: a maximum edge of 3840 pixels, dimensions divisible by 16, aspect ratio
between 1:3 and 3:1, and between 655,360 and 8,294,400 pixels. Maximum square
output is 2880 by 2880; 16:9 output is 3840 by 2160. Resolutions above 2560 by
1440 are experimental.
Verify current model and route support before use.

Those API limits are not a guarantee for the built-in image tool, which may
expose fewer controls. Request the largest native output it supports and report
the dimensions it actually returns. Preserve the whole artwork and its aspect
ratio within the route's limits. Keep production artwork at native size. Never automatically downsize it to
match an input reference.

Make compact input derivatives only when useful for the chosen route, separate
from masters. Keep bundled AI drawing references at or below 1500 pixels on
their longest edge, with a compact encoding and clear lines and lettering.
Keep full-size frame documentation sheets separately. Choose derivative dimensions
for the input route. No fixed square reference copy is required.

## Reference provenance and acceptance

First glimpse is a 1254 by 1254 JPEG of 450,433 bytes, SHA-256
`bb00a4c91e7fb4897b07c140dc6e35458bc7ed089acaf92db0b0a260f172175c`.
It derives from the accepted Finding Your Person r2 PNG, SHA-256
`9bc5e70dfe6ad10ca99bf934e5c52b8f02e645b2915ce74a97f963201b7010e2`,
without the Codex overlay in Nathan's later screenshot.

C is a 1254 by 1254 PNG, SHA-256
`8b003b0002561cc412de0bcb35062b2ba574ab26d667e669908d975e02e60269`.

Keep the four references supplied on 6 October recoverable:
[brain swap and heart](../assets/style-references/brain-swap-and-heart.png),
[mystery date](../assets/style-references/mystery-date.png),
[birthday song](../assets/style-references/birthday-song.png), and
[missing ingredient](../assets/style-references/missing-ingredient.png).
They are historical, outside the active reference set. The four recent redraws
remain pending Nathan's approval. Keep redraw candidates out of the active
reference set until Nathan accepts them as additional references. First glimpse
remains primary.

## Deliver the candidate

Deliver the image and exact caption with the master path, actual dimensions,
lettering measurements and placement PPI when known. Report checked drawing,
characters, dogs, frames and page harmony, plus mismatches and missing proof.
Distinguish visual comparison, screen colour review and production colour proof.

Preserve original, candidate and accepted artwork versions. Deliver corrections
as separate versions within the authorized scope. Mark a candidate accepted
only after Nathan accepts that version; style approval alone does not change
its status.
