# NotebookLM operations

Use the executable and selected profile described in the skill. Inspect
`run notebooklm capabilities` for the complete 53-tool admission matrix.
The catalogue snapshot was obtained from vendor `notebooklm-mcp-cli` 0.15.8.
[Upstream source](https://github.com/jacob-bd/gemini-notebook-mcp-cli) owns the
vendor protocol. New versions require schema and reply qualification.

## Rename a notebook or source

`notebook_rename` takes `notebook_id` and `new_title`. `source_rename` also
takes `source_id`, whose membership is checked in that exact notebook.

1. Confirm the user's authority covers that target and rename.
2. Run the operation with `--preview`. Review its target and expiry against the
   requested input. Previews expire after 15 minutes. The journal stores hashes
   and identifiers, not titles, source content, cookies or raw replies.
3. Run it with `--apply PREVIEW_ID` and the identical `--input` and profile.
   A changed notebook or source inventory invalidates the preview.
4. Report success only after read-back proves the requested title. One preview
   dispatches at most once. A repeated apply refuses, including after success.

Profile writes are serialized. An unresolved receipt blocks further writes
through that profile. Do not reauthenticate a profile as a different Google
account while it holds previews or unresolved receipts. The connector does
not claim account identity isolation against a separately modified vendor
profile or direct vendor operations.

## Unknown outcome

`recover notebooklm --select profile=PROFILE` lists unresolved receipts.
Add `--run RUN_ID` to inspect one. Add `--adjudicate --input '{}'` to inspect
only its bound notebook/source and settle a proved rename. Recovery never
sends the write again. An old title does not prove a timed-out write cannot
land later, so insufficient evidence leaves the receipt unresolved.

`--unlock` only removes a lock whose recorded process is proven absent. It
does not settle a receipt or authorize replay. A malformed journal blocks
writes until its storage integrity is restored.

## Explicit qualification gaps

Notebook creation/deletion, adding/deleting/synchronizing sources, sharing,
chat queries and configuration, labels, notes, research, batch/pipeline work,
generation and revision, downloads and exports remain `blocked` in the
capability catalogue. Each needs an exact input policy, validated output
projection and effect-specific recovery proof before admission. Token
ingestion and MCP authentication refresh remain forbidden.

The restored skill supports the qualified read and rename routes. A schema
snapshot does not prove authentication, live reads, live writes, generation,
exports or activation in another machine's agent harness.
