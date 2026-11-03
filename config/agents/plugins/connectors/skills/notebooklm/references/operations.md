# NotebookLM operations

Use the executable and selected profile described in the skill. Inspect
`run notebooklm capabilities` for the complete 53-tool admission matrix.
The catalogue snapshot was obtained from vendor `notebooklm-mcp-cli` 0.15.8.
[Upstream source](https://github.com/jacob-bd/gemini-notebook-mcp-cli) owns the
vendor protocol. New versions require schema and reply qualification.

## Admitted reads

The exact seven admitted operations are `server_info`, `notebook_list`,
`notebook_get`, `notebook_describe`, `source_describe`, `source_get_content`
and `studio_status`. Use their schemas for required targets and limits.
Readiness does not enumerate notebooks. Describe suggestions contain
`question` and `prompt` fields; output projections discard extra vendor fields.

## Learning-pack reads

`pack_check` and `pack_status` are Connector reads, not vendor tools, and sit
outside the 53-tool catalogue; `capabilities` lists them as
`packOperations`. `pack_check` reads only registered, contained pack files.
`pack_status` reuses `notebook_get`, and two internal marker reads with fixed
policies: `studio_status` with details in pages of 20 (at most two pages) and
`notebook_list` with 20 results for the advisory scan. Their projections keep
only ids, titles, types, statuses, custom instructions, source ids, duration,
pagination, the vendor notebook URL and the list total. The public
`studio_status` still refuses details, and the internal reads have no public
name. See [learning packs](learning-pack.md).

The internal reply shapes were modelled from vendor source older than 0.15.8.
Live 0.15.8 detail fields, pagination, notebook URL and list total remain a
qualification gap until a live read records them.

## Withheld renames

`notebook_rename` and `source_rename` are blocked. Vendor 0.15.8 automatically
retries their RPCs after HTTP 5xx responses. Its public rename tools expose no
setting to disable that replay; `NOTEBOOKLM_RATE_LIMIT_MAX_RETRIES=0` controls
rate limits only. An uncertain rename could be sent again after an intervening
edit, so a local receipt cannot establish at-most-once dispatch.

Nathan chose to keep reads and withhold renames until a non-replaying vendor
route is qualified. Ordinary rename calls return `capability-not-qualified`.
Preview, apply and recovery use the Front Door's `adapter-has-no-writes`
refusal. This release creates no NotebookLM write journal or receipts. No live
writes were attempted by the candidate that preceded this restriction.

## Other qualification gaps

Notebook creation/deletion, adding/deleting/synchronizing sources, sharing,
chat queries and configuration, labels, notes, research, batch/pipeline work,
generation and revision, downloads and exports remain unadmitted in the
capability catalogue. Each needs an exact input policy, validated output
projection and effect-specific recovery proof before admission. Token
ingestion and MCP authentication refresh remain forbidden.

A schema snapshot does not prove authentication, live reads, live writes,
generation, exports or activation in another machine's agent harness.
