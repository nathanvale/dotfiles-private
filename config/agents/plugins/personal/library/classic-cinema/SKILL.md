---
name: classic-cinema
description: "Browse movies and generate ticket-style confirmation emails for Classic Cinemas Elsternwick. Use when Nathan asks what's on at the cinema, wants movie details, or wants to 'book tickets'. Generates a personal reminder email — does NOT purchase tickets."
role: tool-workflow
argument-hint: "[movie] [time] [tickets] [zone]"
allowed-tools: Bash, Read, AskUserQuestion, Write
---

# Classic Cinema

Personal reminder-email generator for Classic Cinemas Elsternwick. Walks a
conversational booking flow, generates a ticket-style HTML email, and sends it
via `gog`. Does NOT purchase tickets or reserve seats — Nathan buys at the box
office.

## Run Card

- Scope: browse movies, pick session, choose seats, generate + send reminder email.
- Defaults: 1 adult ticket, zone picker for seats, Elsternwick venue.
- First safe action: classify intent, then fetch listing or parse args.
- Visible state: availability emoji on every session, seat count, email preview before send.
- Verify: `heal-skill check` after any src/ change.
- Publish: confirmation email sent via `gog`, booking-log entry appended.
- Fallback: API down → report and stop. Email send fails → show the HTML and stop.

## Intent Classification

Classify and proceed. Do NOT show a menu unless intent is genuinely ambiguous.

| Signal | Route | Action |
|--------|-------|--------|
| Args with movie name + time | Express | Parse args ([arg-parsing.md](references/arg-parsing.md)), proceed to booking flow |
| Movie name only, no time | Express | Show that movie's sessions, ask which |
| No args / "what's on" / "what's showing" | **Browse** | **Fetch listing immediately and show the table** |
| Ambiguous | Fallback | Show the menu below |

### Ambiguous-only menu

Present only when intent classification returns Fallback:

1. **What's on** — fetch listing, pick from the table.
2. Quick book — `/classic-cinema <movie> <time> [tickets] [zone]`.
3. Movie details — look up a specific movie.
4. Health check — `bun --no-install "$SKILL_DIR/dist/heal-skill.js" check`.

## Owner

- Runtime: **Bun**. Set `SKILL_DIR` to the directory containing this loaded `SKILL.md`; run `bun --no-install "$SKILL_DIR/dist/<command>.js"`. Development sources live under `src/`. Each command's `--help` is the source of truth for flags, stdout/stderr, temp files, and exit codes — do not copy them here.
- Shared API client + types (base URL, fetch+cache, AEST time, seatmap shapes): `$SKILL_DIR/src/cinema-api.ts`.
- Booking-log model + validation: `$SKILL_DIR/src/booking-log.ts`.
- Booking choreography and API details: `$SKILL_DIR/references/booking-flow.md`.
- Argument parsing: `$SKILL_DIR/references/arg-parsing.md`.
- Email template fill: `$SKILL_DIR/references/template-fill.md`.
- Email sending: `$SKILL_DIR/references/email-send.md`.
- Booking log shape: `$SKILL_DIR/references/booking-log.md`.
- Skill health doctor: `$SKILL_DIR/src/heal-skill.ts` (run `heal-skill check` when a booking fails or output looks wrong).
- Legacy Python scripts under `scripts/*.py` are superseded by `src/*.ts`; retirement criteria: `$SKILL_DIR/references/retirement-criteria.md`.

## Express Mode (3 questions max)

Parse args right-to-left: zone → tickets → time → movie remainder. See [arg-parsing.md](references/arg-parsing.md).

1. **Movie + session** — fuzzy match, show sessions with availability emoji
2. **Tickets** — "1+1" = 1 adult + 1 child. Default: 1 adult. ⚠️ Some sessions (arthouse, festival, late-evening) have **no Child tier** — fallback to "2 adults" with Nathan's confirmation, never silently. See [booking-flow.md](references/booking-flow.md#q2--tickets).
3. **Seats** — zone picker or full map (see Availability UX below)

Best case: `/classic-cinema faraway 10am 1+1 middle` → zero questions → confirm → send.

Full choreography in [booking-flow.md](references/booking-flow.md).

## Browse Mode

1. Fetch movie listing via API (instant)
2. Show the listing table, then present **Next Safe Actions (post-listing)**
3. **Movie details** — when Nathan asks about a movie, use the API data first (`summary`, `trailer` URL). Supplement with WebSearch only if Nathan wants more (reviews, cast, etc).
4. Nathan picks a movie → show sessions with availability emoji, then present **Next Safe Actions (post-sessions)**
5. Nathan picks a session → converge with Express at Q2 (Tickets)

Full choreography in [booking-flow.md](references/booking-flow.md).

## Next Safe Actions

DX lens: present choices as a short numbered list so the user can reply by
number. Bold the recommended default. Never present more than 4 options.

### Post-listing (after showing tonight's movies)

1. **Pick a movie** (reply by number or name) — see sessions + availability.
2. Movie details — trailer, synopsis, or reviews for a specific title.
3. Quick book — `/classic-cinema <movie> <time> [tickets] [zone]`.
4. Nothing tonight — done.

### Post-sessions (after showing a movie's sessions with availability)

1. **Pick a session** (reply by number or time) — check tickets + seats.
2. Back to listing — see all movies again.
3. Movie details — trailer, synopsis, or reviews.

### Post-booking (after email sent)

1. **Done** — booking logged.
2. Book another — back to listing.

## Availability UX

| % Available | Emoji | Label | Seat behavior |
|-------------|-------|-------|---------------|
| 51-100% | 🟢 | plenty available | Zone picker |
| 21-50% | 🟡 | filling up | Zone picker |
| 1-20% | 🔴 | almost full! | Auto-show full seat map |
| 0% | 🚨 | SOLD OUT | Block, suggest alternatives |

Always show raw numbers: `🟢 94% available (141/150 seats)`

**≤20% available rule:** skip zone picker, render full seat map. If Express provided a zone arg, override it — tell Nathan why: "Only N seats left — showing the full map."

## Commands

Set `SKILL_DIR` to this loaded skill directory. Each `--help` owns its flags; inspect it rather than guessing.

| Step | Command |
|------|---------|
| Listing / details | `bun --no-install "$SKILL_DIR/dist/list-movies.js" [--movie QUERY]` |
| Availability | `bun --no-install "$SKILL_DIR/dist/check-availability.js" --session-ids ID[,ID]` |
| Tickets + pricing | `bun --no-install "$SKILL_DIR/dist/parse-tickets.js" --session-id ID --spec "1+1"` |
| Seat pick | `bun --no-install "$SKILL_DIR/dist/pick-seats.js" --seatmap-file PATH --zone ZONE --count N` |
| Fill email | `bun --no-install "$SKILL_DIR/dist/fill-ticket.js" …` (then send via `gog`, see [email-send.md](references/email-send.md)) |
| Health doctor | `bun --no-install "$SKILL_DIR/dist/heal-skill.js" check` |

- Pass the API `headerImage` value to `fill-ticket.ts`; do not guess a Classic Cinemas URL or use `posterImage`.
- Do not copy command flags, temp-file names, JSON shapes, or stdout/stderr contracts into this file.

## Gotchas

- **Always emit booking-log entries with `jq -cn` (compact), never bare `jq -n`.** `jq -n` pretty-prints multi-line by default, so one entry becomes many lines and corrupts the one-line-per-entry JSONL. `parse-tickets.ts` and the send flow write through `Bun.write`; if you hand-append, build with `jq -cn` and `>>` it. Recover with `heal-skill repair --only booking-log-valid --execute`.
- **`fill-ticket.ts` uses `replaceAll`, not `replace`.** `{{MOVIE_TITLE}}` appears 3× and `{{WEB_VIEW_URL}}` 2× in the frozen template; a single-occurrence replace would ship literal `{{…}}` tokens in the email.

## Verification

- After any `src/` change: `config/agents/plugins/personal/library/test-runner/src/test-runner.sh run --cwd $SKILL_DIR -- src/cinema-api.test.ts src/pick-seats.test.ts src/fill-ticket.test.ts src/booking-log.test.ts` and `cd $SKILL_DIR && bunx tsc --noEmit -p tsconfig.json`.
- After any change: `bunx biome check --diagnostic-level=error $SKILL_DIR/src/`.
- Whole-skill health (scripts, frozen template, booking log, owner paths): `bun --no-install "$SKILL_DIR/dist/heal-skill.js" check`.
- Use live API checks only when listing, availability, or booking choreography changed.

## Safety Invariants

- **NEVER click CHECKOUT** on the Classic Cinemas site (triggers real payment — G7/G10)
- Always confirm before sending email (AskUserQuestion)
- Never hard-code the Gmail account — read from `.productivity.yml` (fall back to `~/code/my-second-brain/.productivity.yml`)
- Validate seats against regex `^[A-Z]\d{1,2}(, [A-Z]\d{1,2})*$` before template fill

## References

| File | Content |
|------|---------|
| [booking-flow.md](references/booking-flow.md) | Full choreography for both modes, API details, error table |
| [arg-parsing.md](references/arg-parsing.md) | Argument parsing spec (right-to-left, examples) |
| [template-fill.md](references/template-fill.md) | 13 template placeholders, HTML escape rules, ticket/invoice line format |
| [email-send.md](references/email-send.md) | `gog gmail send` invocation, temp file handling |
| [booking-log.md](references/booking-log.md) | JSONL schema at `~/.local/state/classic-cinema/bookings.jsonl` |
| [retirement-criteria.md](references/retirement-criteria.md) | Legacy plugin retirement checklist |
| [assets/ticket-template.html](references/assets/ticket-template.html) | HTML email template (frozen, never modify) |
