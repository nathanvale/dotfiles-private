# Bake-off coordinator

Use the private `report.md` instance as the run brief, checkpoint, and attempt
ledger. It is the resumption map, not authority to repeat an action.

## Choose the run mode

- **New competition:** create a new non-sensitive run ID, report, contenders,
  and zeroed scores. Withhold previous contender solutions and site runbooks.
  Carry forward settled task choices, still-applicable authority, and applicable
  infrastructure evidence after checking each against the new brief.
- **Continue competition:** keep the run ID, allocation, attempt ledger, and
  each contender's own learning. Resume from the latest checkpoint and
  immutable result evidence, treating older planning claims as historical.
  Refresh lane readiness, application baseline, authority, and every mutable
  prerequisite before the next action. Inspect an uncertain prior effect
  instead of replaying it unless the user has stopped the run or revoked access.
- **Recipe reuse:** follow [storage.md](storage.md). Treat the recipe as
  technique and its evidence as prior proof, never current authority.
- **Stop:** stop dispatch immediately, retire owned operators and workers, and
  update the checkpoint with no next browser action. Resume only after an
  explicit request selects new or continue mode.

A mode change does not widen authority. Preserve permission only while its
target, effects, and other conditions still apply. Apply a later restriction or
revocation immediately. After revocation, retain uncertain application effects
for a permitted human or later authorized inspection; make no page read, reset,
or admission request.

## Hold one run brief

Record one current application and, only when approved, one subsequent
application. Record the workflow, private task-input reference, success and
baseline evidence, allowed effects, stopping boundary, and next action.
Record the current approved adapter set, attempts per adapter and total before
release. Explicit run-specific choices override preset defaults; retain those
choices across interruption. Count acceptance per approved current application,
not an unapproved future application. Label proposed targets as proposals. A visible tab, screenshot, or historical
note does not settle task authority. If the current target is ambiguous, ask one
focused target question before preparing either tab, and include the literal
question in the handback: "Which single current application should this run
use?" Name the confirmed current application in progress without exposing its
private URL.

For an unspecified adapter set, select only adapters relevant to the question
and explain the selection before allocation. Preserve all four when requested.
A recipe-reuse request does not start another comparison.

Run `command -v browser-lane` once and retain the returned executable path in
the private report. Then run `browser-lane --help`; that help owns current
syntax, plan schemas, and supported flags. Use the packaged
[lane-entry.md](../../../references/lane-entry.md) and adapter skill paths as
resolved from this skill. Stop on a missing owner or unsupported syntax; do not
guess a plugin-relative launcher or probe `--version` or another undocumented
flag.

## Token-efficient preparation

- Run existing deterministic checks for hashes, versions, and required fields
  first. Skip preparation agents when current evidence settles qualification.
- For remaining evidence gaps, use one fresh Luna / Medium preparation agent
  across the run, alongside the coordinator's brief preparation. Give it exact
  files and relevant excerpts, not conversation history or site solutions.
- Request at most 200 words: reuse decision, supporting evidence, missing
  checks, and next safe action. Retain the result; refresh only changed evidence.
- Escalate conflicting evidence or unclear adapter fit to Terra / High only
  when Luna identifies that ambiguity. The coordinator owns the handoff; no
  nested agents. Cap total preparation-agent work at two active minutes inside
  the setup budget, including escalation. Return unresolved gaps at the cap.
- Give preparation agents read-only evidence work, without browser authority.
  The coordinator owns inputs, authority and acceptance; the browser worker
  owns fresh baseline checks. Pass only qualification facts to contenders.
- If the requested model is unavailable, report the gap without silently
  substituting a more expensive model. Keep Sol for the named browser blocker
  under the specialist policy below. Record exposed usage; do not infer savings.

## Worker routing and budget

For a new run, use the plugin's `browser_bakeoff_worker` custom role, declared
in [browser-bakeoff-worker.toml](../../../agents/browser-bakeoff-worker.toml).
It pins Terra / High for bounded browser discovery, scripts, and verification.
One instance owns an adapter across its learning attempts. Resume that instance
with its own next attempt; replace it only if unavailable or contaminated.
Keep independent recipe acceptance fresh and the model policy equal across
compared adapters.

Installation includes a companion registration: Codex discovers role TOMLs in
`${CODEX_HOME:-$HOME/.codex}/agents`, not automatically inside plugin payloads.
At plugin installation/update, copy the two shipped `agents/*.toml` files there
and verify byte agreement. Preflight both destinations; preserve any differing,
symlinked or nonregular user file and report the conflict before writing. This
belongs to installation, not repeated contender setup. Existing exact matches
need no write. Start a fresh session to load newly registered roles.

Check the advertised role once per run and record metadata returned naturally
by worker creation. Keep missing runtime model/effort `unverified`; a role
declaration is not runtime proof. Do not launch extra metadata probes for the
default policy. If the custom role is unavailable but the Harness supports a
fresh agent explicitly requesting the same model and effort, use that fallback
and record it. If neither is available, return one concrete routing handoff.
An explicit run requirement for verified runtime identity remains a release
gate; retain its applicable exception. Continuing runs keep their agreed policy.

Give each relevant adapter one initial attempt to discover a complete candidate.
Use a second or third only when no complete candidate exists or a named
uncertainty remains. Name that question before release; otherwise skip the slot
with its reason and reserve acceptance/reset time. An explicit fixed count runs
its slots with repeatability as the objective. Keep skipped, consumed, and
successful attempts distinct.

Reuse scripts and concise cumulative learning instead of replaying exploration
or passing entire transcripts. Reuse applicable setup qualification. Browser
workers operate solo and return concrete blockers directly. The coordinator
may use one [Sol / High specialist](../../../agents/browser-bakeoff-specialist.toml)
per run for a named blocker. Use `browser_bakeoff_specialist`, or an explicitly
selected fresh Sol / High agent if that role is unavailable. Supply only the
affected adapter's concise evidence and owned script paths. Give no browser
authority; Terra remains the browser operator.

Cap specialist work at three minutes or the smaller remaining attempt/run
budget, including its return. Record naturally exposed routing and usage;
mark the resulting attempt assisted. If dispatch is unsupported, time expires,
or the specialist cannot resolve the issue, retain the blocker. No nested
agents or second escalation. Advice does not prove a script works; the browser
worker verifies it within the same authority and remaining budget.

## Whole-run limit

For a new one-app run, default to 30 active minutes across setup, reasoning,
browser calls, resets, synthesis, acceptance, and reporting. Allow at most five
minutes for initial setup; allocate five per learning attempt by default, including
its handback.
Reserve the last five run minutes for acceptance, reset, and delivery. Skip
contenders that cannot fit a viable attempt; never recover a setup overrun by
compressing every attempt. Keep five-minute attempt allocations, or a longer
applicable proven duration. A broader task cannot justify a shorter cap.
Explain reduced coverage; fixed contender counts require a budget handoff if
they cannot fit. User-authorized shorter caps require the instruction reference.

Before each dispatch and at closeout, update the report template's
`browser-lanes-budget` record and run `report-closeout.mjs --file REPORT.md
--require-budget` from this skill's scripts directory. Record allocations, not
actual completion times. For dispatch, list only remaining attempt caps; at
closeout, list all allocated caps. Setup overrun stops new dispatch and requires
a budget handoff; keep the violation in the final report. Reduce contenders
before exhausting setup or the acceptance reserve. Never change evidence to
make validation pass. A rejected report still records the failed run honestly.
Use prior duration only when authorized and applicable; blind contenders must
not receive withheld runbook knowledge. With no authorized timing evidence,
use the five-minute default.

Record the start time, active time consumed, remaining budget, and any human
handoff waiting separately. Check the remaining budget at each phase/attempt
boundary and use tool timeouts within it. Human waiting pauses active time;
agent reasoning, polling, and repair do not. Preserve the budget on resume.
Record tokens/cost only when exposed, otherwise unknown. A time limit is not
proof of a token saving or an enforced token quota.

On exhaustion, stop new work, retire owned operators, and return the current
result and unresolved effects. Do not extend the run automatically. Attempt
authorized reset within the reserved time; if it cannot be proved, retain the
uncertainty and stop. Explicit user Stop or revocation permits no reset.
User-specified run budgets override these defaults; fixed attempt counts do
not silently enlarge the run budget.

## Prepare and release contenders

Apply the qualification policy in
[scripts.md](../../../references/scripts.md). Fresh lane health and exact
task-page readiness remain required even when capability evidence is reused.
When the evidence is sufficient, record it as reused and proceed directly to
fresh lane health and exact task-page readiness without a fixture or admission
detour. Record qualification as setup, outside the attempt ledger.

Reconcile authority, remaining budget, baseline and exact readiness before
dispatch. Create or resume the assigned worker with an explicit release and
start its timer at dispatch. It still follows fresh lane gates before browser
actions. Only an explicit requirement for verified runtime identity needs a
held preflight; resolve it once using supported own-worker metadata or its
applicable exception. A task name is not a native agent UUID.

Resolve an ambiguous input once during setup and record its interpretation.
When task inputs, qualification, and baseline are ready, release the custom
worker automatically.

After each handback, inspect its application effect, uncertain effect, cleanup
state, and exact next safe action. Repair or prove the baseline before releasing
the next worker.

Pass only the lead's routing fields and the applicable authorization into its
brief, not raw agent/task-status responses containing other summaries. Apply
the contender's [runtime evidence boundary](../assets/contender.md#runtime-evidence)
before any metadata query. If a held lead receives competing material, retire
and replace it before release; no timed attempt was consumed. For exposure
discovered after release, invalidate the comparison result and retain the
consumed attempt, even if the exposure occurred during preflight.

Keep one browser operator active. Release one eligible contender at a time in
the challenge order. A fresh lead receives no competing result, coordinator
history, site runbook, or another contender's learning.

Choose the next eligible adapter/attempt from the recorded allocation before
constructing its brief. A correction or changed cap updates that allocation;
it does not erase consumed attempts.

For later attempts, resume the same worker with the next attempt number,
current authority/baseline evidence, budget, and learning objective. Refer to
unchanged inputs and scripts by path; do not retransmit them. A replacement
receives the shared brief and concise cumulative own learning and scripts from
every earlier attempt. Preserve rotated order and refresh exact readiness.

## Checkpoint and progress

Update the checkpoint after qualification, every attempt, every reset, and any
stop, interruption, timeout, authority change, or uncertain effect. Preserve
completed evidence before ending a turn. On resumption, read the checkpoint and
immutable result evidence, then refresh live authority and readiness before any
action.

Patch the small mutable checkpoint and affected attempt/reset row. Keep stable
brief and qualification facts once; reconcile stale delivery claims at closeout.
Complete [post-run evaluation](post-run-evaluation.md) before final closeout,
including on failure or Stop; after Stop this is report-only.

Give progress only at meaningful transitions or blockers:

> Phase: PHASE. App: APP. Active: ADAPTER attempt N, or none. Completed: X of Y.
> Next: NEXT ACTION.

Use concise phases: setup, adapter and attempt, application effect, baseline
restored, acceptance, promotion, complete. If two active minutes pass without
a checkpoint change, perform one bounded durable-state self-check. Do not poll.
When browser work is complete, release workers and move directly to report-only
closeout.

Call qualification and baseline work setup. State "No scored attempts yet"
until a contender is released. The dashboard reports lane calls; the report
maps calls to competition attempts.

After qualification, report actual required/completed checks and actual scored
allocation. On continuation, preserve earlier scores. Name the next remaining
prerequisite; do not restart setup merely because the task resumed.

## Independent acceptance

After every allocated slot is consumed or explicitly skipped, give a fresh
`browser_bakeoff_worker` instance only the selected
recipe, linked scripts, task inputs and ordinary lane guidance. Require one
complete workflow check for each application actually included in the run. An
approved future application is not a reason to withhold the current result.
Use the authorized effect/reset boundary; a timesheet check stops before Submit.
Record acceptance separately from learning attempts. A failed artifact stays a
candidate: permit one bounded correction and one fresh retest only if the run
budget permits. A second failure or insufficient remaining budget ends with the
candidate, evidence, and concrete blocker. This limit does not erase prior
failures or turn incomplete acceptance into a pass.

Inspect links and hashes from the promoted destination using storage.md. Report
tested execution separately from suggested Recorder or adapter mappings. A
runbook reveal can follow completed acceptance; if references are unavailable,
record that optional comparison as pending rather than keeping the completed
workflow running.

## Stop handback

An explicit user Stop supersedes the normal instruction to inspect an uncertain
effect. Stop dispatch and retire owned processes without issuing a new page
action. After Stop, perform no browser inspection, reset, admission request,
fixture check, or adapter action. Preserve the application effect as unknown
until a later authorized inspection.

Record these outcomes separately:

- dispatch and worker state, including every owned operator retired or still
  unresolved;
- lane custody, lease, and attended handoff evidence;
- adapter cleanup as confirmed, unconfirmed, or unknown;
- known application effects, uncertain effects, and last authorized
  application observation;
- next permitted action, usually none while stopped or access is revoked.

Keep lane custody evidence and adapter cleanup in separate fields. Never merge
them into one outcome or infer either from the other.

An idle activity card or no reported runner does not prove adapter cleanup,
page state, or exclusion of clients that bypass the lane. Preserve compatible
facts together, such as no reported runner and unknown cleanup.
