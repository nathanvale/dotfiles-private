# Adopt Agent Ledger through Tasks

Use the current Task process seam to establish identity and persistence now.
Nathan expects later releases to add Notes, Progress, and coordination decisions.
Treat that as the product direction; verify each capability before using it.

For a delegated tracking assignment, enter [Ledger Steward](#ledger-steward)
directly. The caller retains project and checkpoint binding responsibility.

## Use Tasks and checkpoints for the slice

Apply this branch to authorized implementation and evaluation slices. Planning
alone does not create a Task or activate a goal.

1. Read the playground's storage and project-map rules, active `GOAL.md`, and
   current evidence owner. Resolve the selected Agent Ledger executable and
   discover its public command contract. Reuse the recorded project and Register;
   keep an adopted Register outside Git and transient evaluation receipts.
2. Look for the existing accepted Task in those owners and verify it through a
   supported read command. Resume that identity. Only when absence is established,
   append exactly one Task for the bounded outcome through the public compiled
   process, using its actual request contract. Never use direct SQL product writes.
3. Preserve the append receipt privately and verify acceptance after exit. An
   independent read-only SQLite inspection can confirm durable bytes when public
   reads are absent; label it diagnostic proof. After an uncertain append, inspect
   the exact Register and receipt before retrying. Uncertainty is not absence.
4. Bind project, Register, and accepted Task in `GOAL.md` and the existing slice
   proof, never README. Once project, readable goal, and evidence pointers exist,
   use the installed [checkpoint contract](compaction-recovery.md#save-a-bounded-checkpoint)
   to write private recovery state at meaningful boundaries, such as
   an accepted change, handoff, or interruption. Reuse current pointers; avoid
   checkpoint writes for every command. For missing, stale, uncertain, or
   refused context, use the configured vault's `docs/agents/recovery.md`.
5. Run the [Ceremony Smell Check](../SKILL.md#ceremony-smell-check) during this
   ordinary journey. Keep observations in the existing proof. Keep README stable
   and report the actual Ledger lifecycle even when external work has finished.
   Task acceptance alone does not prove status changes or next-task selection.

If Ledger is unavailable, retain the named current work and evidence owners,
preserve any recorded Task identity, and report the failed command and recovery
route in existing proof. Continue independent authorized work under that explicit
fallback. Do not invent accepted state or bypass checkpoint validation; record
an unavailable checkpoint as a separate gap.

For the initial adoption or a recovery qualification, start a fresh reader at the
ordinary project entry. Require recovery of the same Task, acceptance criteria,
evidence, and missing capability without another append or the original conversation.

## Ledger Steward

Use this branch for task creation, supported lifecycle changes, or reconciliation.
The caller can perform a simple update directly. Delegate a bounded batch,
ambiguous reconciliation, or parallel-worker closeout to `msb_ledger_steward`
when the handoff saves work. Resolve the installed role through
[vault agent routes](vault-agents.md); unavailable native roles are a delivery
limit, not permission to claim a substituted model as the Steward.

### Handoff

Supply the selected executable, Register and program; exact Task identities or
bounded creation requests; requested effects; evidence paths; permitted writes;
and stop boundary. Include the execution owner's actual run identity and
completion generation for an active lifecycle. Advisory handoffs permit reads
only. Delegate disjoint Task sets or serialize reconciliation of the same Task.

### Record the work

- Before work, resolve existing identity and current state. Create only after
  absence is established across relevant Tasks, including completed ones;
  absence from the actionable frontier alone is insufficient. Start work only
  when the named execution owner is actually beginning it.
- After evaluation, compare the accepted checks with the independent verdict
  and its evidence. Record completion only when the required outcome is proved.
  An implementer's finished message or a tidy dashboard is insufficient.
- Preserve an active run's identity and returned completion generation. The
  Steward acts for the named owner only within explicit transition authority.
  Return ownership conflicts to the caller; do not claim or complete another
  agent's run. For finished historical work with no active run, a reconciliation
  may use its own identified verification run; label it as current reconciliation.
- Discover supported reads and transitions from the selected executable. Use
  cancellation or supersession for removal only when supported and authorized.
  Otherwise report the capability gap and preserve the Task and event history.
- Verify committed results through the public read surface. Use read-only
  diagnostics only when that surface cannot answer the identity question, and
  label them as diagnostics. Inspect uncertain effects before any retry; preserve
  the request's identity and generation. Direct SQL writes are outside this route.

### Closeout

Before reporting a slice or batch finished, reconcile its explicit Task set.
Return `Task | observed state | evidence/receipt | remaining gap` and the next
available work from the supported query. Distinguish complete implementation,
accepted evaluation and recorded Ledger completion. A refused or unavailable
transition leaves synchronization incomplete; return its receipt and repair path.

Keep receipts private under the established runtime owner. Keep readable findings
with the existing evidence owner and README maps stable. A delegated Steward
returns its handback to the coordinator; it does not edit knowledge notes, rewrite
acceptance criteria, create another tracking file, or bind a worker's checkpoint.

## Recover with the control panel

After compaction, verify that the installed hook delivers a small control panel
with exact commands to:

- open or read the active project map, goal, and evidence owners;
- discover the selected Agent Ledger executable's current command surface;
- verify the same Register and Task through a supported read command, or an
  explicitly labeled read-only diagnostic route when public reads are absent;
- resume the next safe action within the recovered scope.

For missing, stale, uncertain, or refused context, use the configured vault's
`docs/agents/recovery.md`. The installed checkpoint command owns panel content and
validation; qualify that output rather than maintaining another recovery recipe.
Keep checkpoint state within the installed schema and size limits. Let the
runtime supply executable routes from validated bindings; do not add arbitrary
command fields or copy transcripts into the checkpoint. Add future Progress or
Decision controls only when Ledger discovery proves their operations are supported.

## Keep the future seam small

Use one explicit Register selection and a stable mapping from project/goal to
the returned Task identity. Keep request/response adaptation at the process
boundary. Reuse Agent Ledger's field names and lifecycle rather than creating a
local imitation. Add a wrapper or schema only when a real journey requires it.

Do not build a shadow Notes or Progress database, speculative commands, empty
adapter modules, or README activity logs. Existing planning and accepted
decision artifacts remain their declared fallback owners. Their later transfer
is one scoped migration with a successor pointer and independent proof.

## Qualify a later release

- Refresh discovery and identify which expected responsibility is executable.
- Inspect that release's schema, backup, and migration contract. Preserve a
  verified backup before opening an adopted Register with a changed schema.
- Reopen the same Register through the supported process. Verify that existing
  Task identities and accepted evidence remain recoverable.
- Exercise one new responsibility, persist it, retrieve it, and give a fresh
  reader its normal entry route. Verify that the dashboard follows the owner.
- Transfer only that responsibility after proof; record unavailable or failed
  operations explicitly. Do not rewrite legacy history through invented APIs.
