---
domain_format_version: 1
domain_key: classiccinemas-com-au
vendor: Classic Cinemas
purpose: Browse movie sessions and generate ticket-style confirmation emails for Classic Cinemas Elsternwick (Melbourne, Australia)
session_name: classiccinemas-com-au
engine: agent-browser
auth: none
canonical_status: canonical-managed
phase1_state: promoted
maturity_summary: validated
last_validated: 2026-04-10
expected_identity: n/a
---

# classiccinemas.com.au

Classic Cinemas is an independent Melbourne cinema chain. The canonical managed domain covers **Classic Cinemas Elsternwick** specifically — the caller skill (`classic-cinema` user-scope skill) only targets that one venue.

The underlying task is: browse tonight's session listing, drill into movie details, walk the pricing + seat-map stages, and observe the booking flow end-to-end. The "booking" at Classic Cinemas is anonymous and does NOT require payment or account login to reach a confirmation — this is documented behavior from the prior `the-cinema-bandit` plugin that has been running anonymously for months. The confirmation is a ticket-style email the user brings to the physical cinema box office.

## Target Flows

### bootstrap-observe

- **auth_required:** no
- **expected_identity:** n/a
- **maturity_state:** observation-only
- **promotion_eligible:** no
- **run_id:** classiccinemas-com-au-bootstrap-2026-04-08-001
- **completed:** 2026-04-08
- **notes:** Full walk from homepage → session listing → movie detail → ticket type selection → seat map → pre-checkout gate. Stopped at checkout (irreversible submit) per safety constraint. Anonymous access confirmed (no login wall). 14 screenshots captured. 7 gotchas staged and committed. Key seams identified: browse (homepage/movie-detail SSR, server-rendered), ticket selection (Vue SPA step 1 at `/tickets?c=...&s=...`), seat selection (Vue SPA step 2 same URL), checkout (Vue SPA step 3, NOT observed — Braintree gateway detected, payment status unknown).

### browse-and-price-elsternwick

- **auth_required:** no
- **expected_identity:** n/a
- **maturity_state:** validated
- **promotion_eligible:** n/a (promoted)
- **minted:** 2026-04-08
- **minted_from:** bootstrap-observe iteration 1
- **promoted:** 2026-04-10
- **promotion_basis:** iterations 5 (first SUCCESS), 6 (first recovery-free SUCCESS), 7 (confirmed recovery-free SUCCESS)
- **scope:** API-only data fetch from the tickets page. Opens `/tickets?c=...&s=...` for cookie context, then fetches three API endpoints via eval: `/api/sessions/{c}/{s}` (session metadata), `.../tickets` (pricing), `.../seating-map` (seat grid). No DOM interaction beyond page load — no ticket clicking, no SELECT SEATS, no seat map interaction. Seat selection is done locally by the caller skill using the API data. The skill generates an email confirmation from the collected data without completing any real booking.
- **exit condition:** All three API responses captured as structured JSON. No Vue SPA interaction performed.
- **never do:** Click CHECKOUT. Click ADD TICKET. Click SELECT SEATS. Submit any form. Trigger Braintree. Fill payment details. Interact with the invisible reCAPTCHA. Interact with the Vue SPA DOM beyond reading it.
- **notes:** This is the ONLY real target_flow for this domain. No `complete-booking` flow exists or should be created — the skill is a "reminder email generator that looks like a ticket", matching the prior plugin's behavior exactly. **Simplified 2026-04-09:** Flow reduced from full UI walk (ticket selection → seat map DOM interaction) to API-only data fetch. Seat selection moved to caller skill (local). This eliminates G2, G3, G5, G15, G16 as operational concerns.

## Domain Gotchas

**Operational relevance note (2026-04-10):** All 4 Classic Cinemas APIs confirmed cookie-free (G18). The `classic-cinema` skill no longer dispatches `ba-browse` for ANY stage — the entire flow is `curl` + local scripts. Only **G4** (anonymous flow), **G7/G10** (never click CHECKOUT — safety documentation), and **G18** (API discovery) remain operationally relevant. All other gotchas (G1-G3, G5-G6, G8-G9, G11-G16) are historical context only, preserved for reference if the flow scope ever re-expands to include browser interaction. G2, G3, G5, G8, G9, G11, G12, G13, G14b, G15, G16 are **historical context only** — they document observations from the full UI walk iterations but no longer affect the current flow. They are preserved for future reference if the flow scope ever expands.

### G1: Tab focus drift after `tab new`

**Observed iteration:** 1 (`bootstrap-observe`)

`tab new <url>` does NOT automatically make the new tab the active target for subsequent `snapshot` / `eval` calls — they still target the previously-active tab in shared Chrome. After opening a Classic Cinemas tab while another tab (e.g., GCP console) was active, `snapshot` returned content from the other tab.

**Workaround:** After every `tab new <url>`, immediately call `tab N` (bare number, not `tab focus N`) to re-focus. Verify with `eval "window.location.href"` before proceeding. This is a silent correctness hazard if skipped.

### G2: `SELECT SEATS` button renders below the fold — a11y-ref click fails

**Observed iteration:** 1 (`bootstrap-observe`)

On the `/tickets?c=...&s=...` page, the "Select Seats" button sits at ~top=1446px while the viewport is ~862px tall. The a11y snapshot shows the button, but `click @eN` failed silently. JS click via `document.querySelector('.btn-primary.large').click()` works reliably.

**Workaround:** Use JS `.click()` on `.btn-primary.large` for the SELECT SEATS transition, not a11y-tree ref clicks.

### G3: Seat map renders as Vue SPA — not present in the accessibility tree

**Observed iteration:** 1 (`bootstrap-observe`)

After clicking SELECT SEATS, the seat map is rendered by a Vue.js SPA component with class `.seating-map`. Seats are `<button>` elements with class `.seating-map__button` but they are NOT exposed through the accessibility tree. All seat interaction must go through `eval` with DOM queries.

**Workaround:** For any seat-related interaction, use `eval "document.querySelectorAll('.seating-map__button')"` pattern. Ref-based clicks will not work.

### G4: Fully anonymous flow — no auth walls, no banners

**Observed iteration:** 1 (`bootstrap-observe`)

The entire browse → ticket → seat walk completed without any cookie consent banner, newsletter popup, age gate, or login prompt. This confirms the assumption from the prior `the-cinema-bandit` plugin: the site is browseable end-to-end anonymously. (Note: the CHECKOUT stage beyond seat selection has NOT yet been observed — see G7.)

### G5: Invisible reCAPTCHA is loaded on the ticket page

**Observed iteration:** 1 (`bootstrap-observe`)

Three invisible reCAPTCHA iframes are present on the `/tickets` page (hidden: height=60, width=256, zero display). They may trigger on CHECKOUT submit and could block the booking flow or require human intervention. Not exercised in iteration 1 (pre-checkout stop).

**Risk:** A future `checkout-observe` or `complete-booking` flow may hit an invisible reCAPTCHA challenge. If so, the agent should stop as `NEEDS_HUMAN`.

### G6: `tab focus N` does not switch the snapshot context — use bare `tab N`

**Observed iteration:** 1 (`bootstrap-observe`)

The agent-browser CLI command `tab focus N` does NOT change the active snapshot target. The bare `tab N` (without `focus` subcommand) is the correct invocation — it switches the active tab and returns the tab title + URL as confirmation.

**Workaround:** Use `tab N` not `tab focus N`.

### G7: Braintree payment gateway is loaded on the ticket page — CHECKOUT may involve real payment

**Observed iteration:** 1 (`bootstrap-observe`)

The script `js.braintreegateway.com/web/3.102.0/js/apple-pay.min.js` is loaded on the `/tickets` page. This strongly suggests step 3 (CHECKOUT) includes a real payment step — not just a name/email form. This **contradicts** the assumption in the caller's brainstorm that the "booking" is free and anonymous.

The prior `the-cinema-bandit` plugin's "anonymous booking" may actually mean: the plugin stops BEFORE step 3, gathers the selected session/seats/pricing locally, and generates a ticket-style confirmation email from that data — WITHOUT ever completing the real booking. This would make the email a personal note, not an actual cinema reservation.

**Critical next step before any `complete-booking` target_flow:** A dedicated `checkout-observe` run (or careful inspection of step 3 static content via View Source / `eval`) is required to confirm whether the CHECKOUT button triggers a payment, a free confirmation, or a signup. Do NOT create a `complete-booking` target_flow until this is resolved.

### G8: CHECKOUT button is `type="submit"` but is NOT inside a `<form>` element — it is Vue-handled

**Observed iteration:** 2 (`bootstrap-observe`)

On step 2 (seat map), the CHECKOUT button has `type="submit"` but `checkoutBtn.closest('form')` returns `null`. There is exactly one `<form>` on the page at this step — it is the site-wide search bar (unrelated to booking). The CHECKOUT button fires a Vue click handler that calls `e.changePage("checkout")` — navigating the SPA to step 3. The URL stays at `/tickets?c=...&s=...` (SPA navigation, no full page load).

**Implication:** The CHECKOUT button cannot accidentally submit a form. There is no HTML form submission risk from the keyboard Enter key at step 2 either.

### G9: Step 3 is a TWO-PHASE SPA — "Your Details" first, then payment. CHECKOUT button only navigates to step 3, not directly to payment.

**Observed iteration:** 2 (`bootstrap-observe`)

The `ticketing.js` Vue SPA has three distinct pages. Clicking CHECKOUT navigates to step 3 which is split into two sub-steps:

**Step 3a — CheckoutView ("Your Details"):**
- Renders a customer details form: Given Names, Surname, Email Address, Post Code, Mobile Phone, newsletter opt-in, T&C consent
- On submit: if `balanceInCents === 0` → calls `completePayment(orderId, "noPaymentRequired")` → redirect to `/confirmation/`
- On submit: if `balanceInCents > 0` → calls `changePage("payment")` → navigates to PaymentView

**Step 3b — PaymentView:**
- Only reached if balance > 0
- Calls `fetchPaymentDetails(orderId)` → `GET /checkout/{orderId}` to get Braintree `authorization` token
- Instantiates Braintree `hostedFields` (credit card iframes), Apple Pay, Google Pay, PayPal
- Submit calls `completePayment(orderId, "braintree", nonce, recaptchaToken)` → `POST /checkout/{orderId}`

### G10: G7 CONFIRMED — CHECKOUT does involve real payment for non-zero balances. `complete-booking` flow must never be minted.

**Observed iteration:** 2 (`bootstrap-observe`)

G7 verdict: **CONFIRMED.** Real Braintree payment is required for standard ticket purchases (Adult $27.00 → `balanceInCents: 2700` → PaymentView). The `noPaymentRequired` payment type is only triggered when `balanceInCents === 0` (free events, full gift-card coverage, complimentary tickets).

The `the-cinema-bandit` plugin stopped before the CheckoutView's customer-details form submit — its "anonymous booking" was never an actual cinema reservation. The generated confirmation email was constructed locally from session/pricing/seat data. This is the correct behavior for this skill.

**`complete-booking` target_flow: MUST NOT be minted.** The `browse-and-price-elsternwick` flow correctly stops at the CHECKOUT button boundary.

### G12: Homepage movie cards include poster `<img>` — skill MUST extract it in stage 1

**Observed iteration:** First real skill run 2026-04-09 (The Magic Faraway Tree smoke test)

The homepage "FILMS SHOWING TODAY" section renders each movie as a card containing a thumbnail `<img>`. The ticket template (`references/assets/ticket-template.html`) has a required `{{MOVIE_IMAGE_URL}}` hero image — if the skill doesn't extract the poster URL at stage 1 (browse), the final email renders with a broken/blank hero.

**Workaround:** Stage 1 `ba-browse` dispatch must return a `posterUrl` for every movie card, extracted from the `<img src>` inside the homepage movie card. If the homepage doesn't have it (shouldn't happen, but defensive), fall back to fetching it from the movie detail page (`/movies/{slug}`) before filling the template.

**Failure mode observed:** The skill's first real run for Screen 10 / The Magic Faraway Tree omitted `{{MOVIE_IMAGE_URL}}` and defaulted to empty string per an earlier (incorrect) reference-doc default. The email rendered with a 1px blank hero box showing only the alt text.

### G13: Screen 10 (or non-Screen-1 screens) may use different seat-map markup than Screen 1

**Observed iteration:** First real skill run 2026-04-09 (The Magic Faraway Tree smoke test)

Bootstrap-observe iteration 1 only covered Screen 1 (Project Hail Mary). The first real skill run used Screen 10 and the resulting seat extraction returned `"Row 0 (back), seats 6 & 7"` — indicating either the row letters weren't extracted from `.seating-map__letter`, or Screen 10 uses a different structure altogether (e.g. `data-row` attributes, no letter elements, or a smaller screen with non-alphabetic rows).

**Workaround:** The stage-4 `ba-browse` action prompt must explicitly extract `rowLetter` from `.seating-map__letter` first, then fall back to `data-row` or the row's `aria-label`. If none of those yield a valid `[A-Z]` single character, the agent must STOP — do NOT invent "Row 0" or "(back)" labels. The skill's `references/booking-flow.md` stage 4 now contains an exact DOM-extraction pseudo-script and a validation regex (`^[A-Z]\d{1,2}(, [A-Z]\d{1,2})*$`) that the final `{{SEATS}}` value must match.

**Action:** A future bootstrap-observe iteration targeting Screen 10 (or any small screen) would earn the correct markup knowledge. Until then, the skill fails loudly rather than silently.

### G14: Seating-map API endpoint is the authoritative row-label source

**Observed iteration:** 4 (`browse-and-price-elsternwick`)

`GET /api/sessions/{cinemaId}/{sessionId}/seating-map` returns `rows[].name` as alphabetic labels (`"A"`..`"U"`) and `rows[].seats[].name` as full seat identifiers (`"B1"`, `"C15"`). This is more reliable than DOM extraction and works for any screen layout. The API is fetched automatically by the Vue SPA on ticket page load — no additional authentication needed.

**Implication:** The skill should prefer the API for seat-map data over DOM scraping. This resolves G13's row-label concern for all screens, not just Screen 1.

### G14b: `.seating-map__letter` elements DO exist in the DOM (Screen 1 confirmed)

**Observed iteration:** 4 (`browse-and-price-elsternwick`)

Contrary to what run 003 implied, `.seating-map__letter` spans ARE present on Screen 1 (all 20 rows). Correct extraction formula: `rowLetter = row.querySelector('.seating-map__letter').textContent.trim()` + `seatNumber = btn.querySelector('.seat-name').textContent.trim()`. Row letters: A, B, C, D, E, F, G, H, (gap row with empty letter), J, K, L, M, N, P, Q, R, S, T, U (standard cinema convention — no I or O). Buttons are nested inside `.seating-map__seat` SPAN wrappers, not directly in `.seating-map__row`. Skip gap rows where letter is falsy.

**Note:** Run 003 targeted Screen 10 which may use different DOM structure. This finding is Screen 1 only. The API approach (G14) bypasses this concern entirely.

### G15: External tab focus can disrupt Vue SPA session state

**Observed iteration:** 4 (`browse-and-price-elsternwick`)

If an external tab opens and steals Chrome focus while the Vue SPA is active (e.g., during seat selection on step 2), the SPA may lose its internal order/session reference. Symptom: `.error-overlay` appears with "WHOOPS" title but empty `.error-content`, and `.btn-primary.large` reverts to "Select Seats" with `.close-error` class.

**Workaround:** Complete the full flow in a single uninterrupted sequence. If disrupted, reload the `/tickets` URL to restart from step 1.

**Update (iteration 6):** WHOOPS overlay also appeared with NO tab switching — all intermediate tabs were closed before navigating to tickets. Root cause may be Vue SPA timing on the SELECT SEATS JS `.click()` rather than external tab focus steal alone. The overlay is consistently non-blocking: JS seat selection and data capture work through it. Consider increasing wait time (5s) after `tab new` + refocus before clicking SELECT SEATS.

### G16: Vue SPA stuck on spinner after `open` navigation to /tickets — reload fixes it

**Observed iteration:** 5 (`browse-and-price-elsternwick`)

When the tickets page is loaded via `agent-browser open <url>` (without `tab new`), the Vue SPA's ticket type selection step may remain in a perpetual spinner state. The `.Loading` div is `display:none` (loading screen finished) but the `.Spinner` SVG inside it remains `display:block`, and the ticket type component classes (`Ticket`, `Price`, `Quantity`, `Steps`) never appear in the DOM.

**Workaround:** A simple `agent-browser reload` on the same URL triggers a full Vue SPA re-initialization and the ticket types render within 5-8 seconds. This may be related to session/Vue state not being fully initialized when navigating from the now-showing page.

**Note:** This did NOT occur in prior iterations where `tab new` was used. The `open` command navigates the current active tab, which may skip some Vue lifecycle initialization that happens on a fresh tab context.

### G11: Braintree SDK is pre-loaded on ALL ticket pages but only INSTANTIATED on the payment sub-step

**Observed iteration:** 2 (`bootstrap-observe`)

Seven Braintree scripts load upfront on `/tickets` (client, data-collector, hosted-fields, three-d-secure, paypal-checkout, apple-pay, google-payment). At step 2, `window.braintree` IS populated with all SDK methods but there are zero Braintree DOM elements and no active client instance (`window.braintreeClient === undefined`).

The SDK is pre-loaded for performance. It only gets instantiated when the user reaches PaymentView via `braintree.client.create({authorization: token})` where `token` comes from `GET /checkout/{orderId}`.

**Implication:** Braintree presence at step 2 is not evidence of active payment processing. The agent can safely operate at step 2.

### G18: Public listing APIs exist — no browser needed for movie/session catalog

**Observed iteration:** 8 (`browse-and-price-elsternwick`)

Two anonymous API endpoints return the full movie catalog and session schedule without any browser context:

- `GET /api/movies` — 267-item array of all movies. Fields: `id`, `vistaId` (join key), `slug`, `name`, `summary`, `runtime.minutes`, `duration`, `releaseDate`, `headerImage`, `thumbnailImage`, `posterImage`, `rating.id`, `genres[]`, `trailer` (YouTube ID), `nowShowing`, `link`. The `nowShowing` flag is CMS-managed and unreliable — use sessions API to determine what's actually playing today.
- `GET /api/sessions/0000000002` — 724-item array of all upcoming sessions for Elsternwick. Fields: `id` (sessionId), `cinemaId`, `movieId` (matches `movie.vistaId`), `date` (ISO local AEST), `utcDate`, `screenName`, `screenNumber`, `attributes[]`, `allocatedSeating`, `link`. No date filtering at the API level — query params are silently ignored, client-side filter by `date.startsWith(TODAY)` is required.

**Join:** `session.movieId === movie.vistaId` gives title, rating, poster URL, session times, session IDs, screen names.

**Image URLs:** `thumbnailImage` and `posterImage` are relative paths. Prefix with `https://movingstory-prod.imgix.net/` to resolve. Both `mx/posters/` and `movies/thumbnails/` paths work (HTTP 200 confirmed).

**Additional cookie-free endpoints (confirmed 2026-04-10):**

- `GET /api/sessions/0000000002/{sessionId}/tickets` — returns `{ areas[], categories[], ticketTypes[] }`. Each `ticketType` has: `id`, `name`, `headOfficeGroupingCode` (ADULT/CHILD/SENIOR/etc.), `priceInCents`, `bookingFeeInCents`, `memberPriceInCents`, `maxOrder`, `categoryId`, `areaId`. Category 2 = "Additional Tickets" (standard public types). **Confirmed cookie-free** — works with bare `curl`, no browser context needed.
- `GET /api/sessions/0000000002/{sessionId}/seating-map` — returns `rows[]` with `name` (alphabetic A-Z, skipping I and O per cinema convention) and `seats[]` with `name` (e.g. "B1"), `sold` (boolean), `unavailable` (boolean), `typeId` ("standard"/"gap"/"wheelchair"/"companion"). **Confirmed cookie-free** — works with bare `curl`.

**Implication:** ALL four Classic Cinemas API endpoints work without browser cookies. The `classic-cinema` skill no longer needs ANY browser dispatch — the entire flow is `curl` + local logic. The `browse-and-price-elsternwick` target flow remains documented as domain knowledge but the skill no longer dispatches `ba-browse` for any stage.

## Earned Artifacts

_(empty — promotion is owned by the ba-browse commit pipeline, not manual writes)_

## Iteration Log

| run_id | iteration | target_flow | status | commands_used | discovery_mode_cycles | tool_uses | duration_ms | recovery_used | promotion_recommendation | notes |
|---|---|---|---|---|---|---|---|---|---|---|
| classiccinemas-com-au-bootstrap-2026-04-08-001 | 1 | bootstrap-observe | SUCCESS | 18 | 3 | 37 | 1500000 | no | not_yet | Full walk homepage→movie detail→ticket→seat map→pre-checkout. Stopped at CHECKOUT (irreversible). 14 screenshots, 7 gotchas (G1-G7) committed, candidate selectors staged non-committable. CRITICAL FINDING: Braintree payment gateway loaded on /tickets (G7) — CHECKOUT may require real payment, contradicting original anonymous-booking assumption. Needs dedicated checkout-observe before any complete-booking flow is minted. |
| classiccinemas-com-au-checkout-observe-2026-04-08-001 | 2 | bootstrap-observe | SUCCESS | 22 | 2 | 30 | 600000 | no | not_yet | Static inspection of CHECKOUT step without clicking it. Confirmed: CHECKOUT button is type=submit but Vue-handled (no form). Step 3 is two-phase: customer-details first (CheckoutView), then Braintree payment (PaymentView) only if balanceInCents > 0. G7 CONFIRMED: real payment required for standard tickets. complete-booking flow must never be minted. browse-and-price-elsternwick flow boundary confirmed correct. 4 gotchas (G8-G11) committed. |
| classiccinemas-com-au-browse-and-price-elsternwick-2026-04-09-004 | 4 | browse-and-price-elsternwick | PARTIAL | 20 | 2 | 42 | 960000 | no | not_yet | Full browse-and-price walk on Screen 1 (Project Hail Mary 7:30pm). API investigation discovered 3 endpoints: /api/sessions/{c}/{s}, .../tickets, .../seating-map. Seating-map API returns alphabetic row labels — solves G13 for all screens. DOM .seating-map__letter confirmed present on Screen 1. Seats B1+B2 selected. PARTIAL due to external tab stealing focus mid-flow causing Vue SPA WHOOPS error. All data captured before disruption. 3 gotchas (G14, G14b, G15) committed. |
| classiccinemas-com-au-browse-and-price-elsternwick-2026-04-09-005 | 5 | browse-and-price-elsternwick | SUCCESS | 20 | 1 | 38 | 660000 | yes | not_yet | Full walk: homepage (3 films) → The Drama 9:10pm Screen 4 → tickets API ($27 Adult/$1.95 fee) → seat map (70 available, C5 selected) → pre-checkout stop. WHOOPS overlay (G15) recurred but non-blocking — JS seat selection worked through it. New gotcha G16 (spinner on `open` vs `tab new`) staged and committed. Recovery used: reload for G16, JS bypass for G15 overlay. Seat format C5 passes validation regex. First SUCCESS on this flow. |
| classiccinemas-com-au-browse-and-price-elsternwick-2026-04-09-006 | 6 | browse-and-price-elsternwick | SUCCESS | 20 | 1 | 40 | 600000 | no | eligible | Full walk: homepage (4 films) → Project Hail Mary 7:00pm Screen 4 → tickets API ($27 Adult, $1.95 fee) → 2x Adult selected → seat map (D3+D4 selected, $57.90 total) → pre-checkout stop. G15 WHOOPS overlay recurred despite no tab switching — G15 amended: may be Vue timing, not only external focus steal. No recovery actions. All 6 screenshots + 4 JSON data files staged. Seat format D3, D4 passes validation. First clean recovery_used:no SUCCESS. Flow maturity → candidate. |
| classiccinemas-com-au-browse-and-price-elsternwick-2026-04-10-007 | 7 | browse-and-price-elsternwick | SUCCESS | 13 | 0 | 18 | 420000 | no | eligible | API-only run: homepage (18 films) → Super Mario Galaxy Movie 6:00pm Screen 8 → 3 API endpoints captured (metadata, tickets, seating-map). No Vue SPA DOM interaction. No WHOOPS overlay. No recovery. Clean SUCCESS, 3rd consecutive clean run on this flow. |
