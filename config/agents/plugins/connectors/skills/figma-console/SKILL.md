---
name: figma-console
description: Read and edit one registered Figma file through the pinned local Figma Console and its Desktop Bridge plugin, on the Connectors plugin's packaged route. Use for fresh Plugin API variables, token export, node, component, variant, lint, accessibility, history and screenshot reads, guarded text, variant, token, variable and fill edits, or starting and stopping its owned local session; not for Figma's hosted MCP (use the figma skill), Code Connect, or raw Plugin API code.
---

# Figma Console (local Desktop Bridge)

One packaged route to the pinned Figma Console server and its local-only Desktop Bridge plugin, bound to one registered account and one file key. Every operation is closed and named; no caller supplies code, a config path, or an endpoint. The hosted route stays in the `figma` skill.

Resolve the front door from this skill directory: no global `connectors` command, no dotfiles path.

```sh
SKILL_DIR="<directory containing this SKILL.md>"
CONNECTORS="$SKILL_DIR/../../bin/connectors"
SELECT=(--select account=<account> --select file=<fileKey>)
```

Every command takes both selectors, before the operation. Each prints one JSON envelope on stdout: read `result.outcome`, `result.causeCode` and `result.repairAction`; a refusal names its cause in `result.data.connectorCause`.

## States you cannot assume

Report each state separately, and only what a command just proved:

1. **Registered**: `"$CONNECTORS" auth status figma-console "${SELECT[@]}"` shows `configured: true`. It never probes the session or Desktop.
2. **Session running**: `run figma-console "${SELECT[@]}" session_status` shows a non-null `session`.
3. **Bridge connected to this file**: a guarded read succeeds. Every write and every read except `status` and `session_status` first runs a fixed guard that the bridge's file is the selected file key.
4. **Desktop account verified**: writes also require `figma.currentUser.id` to equal the registered user id. The source manifest declares `currentuser`, but that does not prove the Desktop bridge was re-imported. Report `desktop-identity-unverified` if the running bridge cannot supply the identity; there is no fallback.

## Register

Run once per account and file, with nonsecret values only. The credential stays in 1Password; never pass it.

```sh
"$CONNECTORS" auth configure figma-console "${SELECT[@]}" --input '{"email":"<PAT owner email>","userId":"<Figma user id>","itemId":"<1Password item id>","runtimeRoot":"<evaluated node_modules>","nodeFile":"<absolute node binary>"}'
```

Registration measures the Node binary and refuses a runtime closure or bridge payload that differs from the pins. It is immutable: identical input records nothing; any change refuses `profile-immutable`. Every call rechecks the pins: `runtime-pin-mismatch`, `node-pin-mismatch` or `bridge-pin-mismatch` means the installed bytes changed. Report it; never re-register around it.

## Session

The owned session is one MCPorter daemon in a private namespace for this account and file. Ordinary reads never start it.

1. `run figma-console "${SELECT[@]}" session_start --input '{}' --preview`, then the same with `--apply <previewId>`. It refuses `session-already-running`.
2. `session_stop` the same way. It refuses `session-not-drained` while a call is active or MCPorter marks an unknown outcome.

Keep one Console session per host: the bridge listens on one local port. Stop any other Console server before starting this one.

## Reads

`"$CONNECTORS" schema figma-console "${SELECT[@]}"` lists the admitted operations. Inputs are exact; extra keys refuse `operation-or-input-not-admitted`.

| Operation | Input |
| --- | --- |
| `status`, `read_variables`, `read_file`, `read_changes`, `read_history`, `session_status` | `{}` or none |
| `read_node`, `read_component`, `analyze_variants`, `lint`, `audit_accessibility`, `screenshot` | `{"nodeId":"1:2"}` |
| `export_tokens` | `{"format":"dtcg"}` or `{"format":"css-vars"}` |

Results are diagnostics, never acceptance: `qualification` says so, and `changedDuringRead` reports a file that moved between the guard reads. `binding` says what tied a result to the file: `lint`, `audit_accessibility`, `analyze_variants`, `screenshot` and `read_changes` read the bridge's active file (`guards-only-upstream-active-file`), so keep only the registered file open in Desktop. `status` reports the selection unverified (`fileVerified: false`). `read_variables` and `read_node` return a fresh Plugin API snapshot. `export_tokens` force-refreshes variables first and refuses `stale-or-warning-result` on any cache, stale, fallback or warning mark, and `changed-during-export` when variables moved during the export.

## Writes

A write changes Nathan's Figma file. Run one only when Nathan asked for that change, on a file admitted for writes. Each is two commands with the identical `--input`:

1. `--preview` reads a complete baseline and records `result.data.previewId`. Nothing is sent. It holds the object until applied or unlocked, and expires after 15 minutes.
2. `--apply <previewId>` rechecks the baseline, sends once, and reads back the requested fields.

| Operation | Input keys |
| --- | --- |
| `update_text` | `nodeId`, `text`, `fontFamily`, `fontStyle`, `fontSize` |
| `create_text` | `parentId`, `name`, `text`, `fontFamily`, `fontStyle`, `fontSize` |
| `create_variants` | `parentId`, `name`, `variants` (2 to 10 distinct names) |
| `create_tokens` | `collection`, `tokens` of `{name, type, value, scopes}`; `scopes` must be explicit and fit `type` |
| `update_variable` | `variableId`, `modeId`, `value` (number, boolean, text, RGB or `VARIABLE_ALIAS`) |
| `bind_fill` | `nodeId`, `variableId` of a COLOR variable; replaces every fill of the node with one solid fill bound to it |

### Outcomes

- `SUCCESS_RUN_APPLIED`: the read-back found every requested field.
- `DOMAIN_RUN_EFFECT_UNKNOWN`: the write may have happened, including when the journal could not record its outcome (`result.data.receiptStatus`). Never retry it; its object stays blocked. Run `"$CONNECTORS" recover figma-console "${SELECT[@]}" --run <runId>`, then the same with `--adjudicate --input '{}'`, which settles only when a fresh read finds the change, or finds the receipt's own object exactly as it was at preview.
- `DOMAIN_RUN_FAILED_RECORDED` with `settled-unchanged`: an adjudication settled this receipt unchanged while its apply was still running, and the fence kept the late send from landing. Preview again if the change is still wanted.
- `preview-consumed`, `preview-expired`, `preview-input-mismatch`, `preview-state-changed`, `baseline-changed`, `object-blocked`, `session-not-started`: nothing was sent. Preview again with the identical input, start the session, or resolve the open receipt first.

Adjudication first sets a fence for the receipt in the bridge's device-local storage, so a mutation still running in Desktop refuses (`fenced`) instead of landing after the verdict. `adjudication-inconclusive` leaves the receipt open: the object neither shows the change nor matches its baseline. Report it to Nathan with the receipt; there is no manual mark. A session receipt cannot settle unchanged within a minute of its attempt or while the attempting process still runs (`adjudication-too-early`); adjudicate again after that. A session settled while its attempt still ran reports `DOMAIN_RUN_EFFECT_UNKNOWN`: check `session_status`. A settled receipt is final: no later process reopens it.

`recover figma-console "${SELECT[@]}"` lists `receipts`, `malformed` receipt files and `orphanLocks`. `--run <id> --unlock` ends an unattempted preview, releases a settled receipt's leftover lock, or releases an orphan lock by the id it names; an attempted receipt refuses `attempted-receipt-cannot-unlock` until adjudicated, and adjudicating a settled receipt refuses `receipt-not-open`. A malformed receipt (`journal-corrupt`) blocks every write until Nathan inspects it.

## Guard refusals

These come from the fixed script in Desktop and mean nothing changed: `file-mismatch` (another file is open), `desktop-identity-unverified` (the running bridge did not provide `currentUser`), `desktop-identity-mismatch` (another Figma account), `snapshot-incomplete` (subtree deeper than 8), `node-missing`. Report the cause with the file key; open the right file or account rather than widening the route.

## Not admitted

Raw `figma_execute` code, Code Connect, documentation generation and design-parity comparison refuse. Use the `figma` skill for hosted reads and Code Connect, and the existing parity owner for acceptance. Read [ADR 0007](../../docs/adr/0007-own-local-figma-console-session.md) before widening this route.
