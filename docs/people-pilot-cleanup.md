# People pilot working-copy cleanup

`bin/system/people-pilot-cleanup.py` owns deletion of the people-metadata pilot's
temporary working copies. It reads only
`~/.local/state/my-second-brain/people-metadata-pilot/working/<collection-id>/manifest.json`.
It never reads message applications, profiles or the vault, and makes no network calls.

The canonical playground trial design owns accepted scope and retention. This
command implements its thirty-day working-copy rule. It does not authorize new
collection, provider calls, retention extensions or profile changes.

Run without arguments for a dry run. `--apply` deletes expired entries and
writes content-free receipts. Each receipt has its own filename, preserving
failed and partial attempts even after a successful retry. Exit status 1 means
the store, manifest or deletion needs inspection. Concurrent invocations use a
nonblocking lock. A busy invocation makes no changes.

The root, `working`, `receipts` and each collection directory must be owned by
the current user, have no group/other permissions and contain no symlinked path
components. Payload files should use mode `0600`. A manifest has this contract:

```json
{
  "schema": 1,
  "collection_id": "opaque-collection-id",
  "collected_at": "2026-11-01T13:00:00+00:00",
  "expires_at": "2026-12-01T13:00:00+00:00",
  "deletion_operator": "com.nathanvale.people-pilot-cleanup",
  "temporary_entries": ["inputs.json", "expectations.json", "response.json"]
}
```

Expiry must equal original collection plus thirty days. Transfers, derived
copies and reruns keep both timestamps. Each temporary entry is a direct child
of the collection directory. Listed directories may contain nested files;
symlinks, foreign-owned entries, special files and unlisted top-level entries
cause refusal. Missing listed entries are tolerated for retry after partial
deletion. The manifest and collection directory are removed after the listed
working copies. Receipts retain only the opaque collection ID, observation time,
status, entry count and a generic failure cause.

On each participating Mac, the installed copy is
`~/.local/bin/people-pilot-cleanup.py`. The user LaunchAgent
`com.nathanvale.people-pilot-cleanup` invokes `/usr/bin/python3` with that absolute
path and `--apply`, using `RunAtLoad` and a sixty-second `StartInterval`. Its
stdout and stderr go to `/dev/null`; deletion receipts stay under the pilot
root. Verify the installed source hash, `launchctl print` result and an expired
disposable fixture on each host. The job runs in the logged-in user session.
Shutdown, sleep and logout can delay cleanup until the next available run;
future private collection needs an operating window that meets the deadline.

Apply and verify `tmutil addexclusion` on the pilot root before storing working
material. Verify incidental log/cache locations separately. Exclusion does not
erase historical backups. Retain source messages and approved profiles with
their existing owners.

For the Mini extraction route, keep `127.0.0.1:1234` and the existing SSH policy.
With the daemon stopped, preserve unrelated HTTP-server options and set
`logSensitiveData=false`, `logIncomingTokens=false`, `verbose=false`, and
`fileLoggingMode="off"` in LM Studio's existing HTTP-server configuration.
Restart the installed daemon and restore the existing ensure LaunchAgent.
Verify settings readback and unchanged log/history metadata around the actual
synthetic requests. These settings do not prove model extraction quality.

## Source-only extraction preparation

`bin/system/people-pilot-extraction.py` prepares the request and validates the
response. It makes no network calls and has no expected-answer input. Use
`prepare --input <prepared-unit.json> --output <request.json>` and
`validate --input <prepared-unit.json> --response <response.json> --output <candidates.json>`.
Use `prepare-team` and `validate-team` with the same arguments for the separate
team-name request. Every unit uses both source-only calls, including units with
no team evidence. Concatenate their validated candidate and missing arrays.
Neither request receives the other response or an existing profile.
Each output must be a new file; existing evidence is never overwritten.

A prepared unit contains only `unit_id`, `speaker`, `addressee`, `source_date`
and `text`. The helper supplies field definitions, lexical offsets and every
contiguous lexical span as unlabeled schema alternatives. Qwen selects values
and fields; the schema couples each quote to its source offsets. It does not
encode reference answers. Each field has either candidates or an explicit
missing reason. The validator checks the original response's normal content,
subject, speaker, date, literal spans and consistent field state before making
a mechanical projection to flat candidates. It never recovers data from the
reasoning channel, corrects offsets or adds omitted facts.

Team-name extraction is deliberately absent from the broader request. The
focused request's `team_name` slot projects to the accepted `team` field. It
requires the model to identify any excluded category word before selecting the
name. It first quotes explicit team wording, with a separate missing branch
when the source merely names an employer or title. Validation requires the name
inside that evidence and rejects overlapping category/name spans; it never trims the
name after generation. Temporal evidence has separate `status_markers` and
`date_limits` slots, which project to the candidate's quoted qualifiers. This
keeps tense wording and date restrictions separately visible. These are syntax
choices within extraction, not Jev's semantic status or relationship judgments.

The installed runtime rejects `oneOf`. The request uses `anyOf` alternatives
that are mutually exclusive by their constant values or field states. Recheck
the actual API when changing grammar syntax; successful lower-level compilation
alone does not establish API compatibility.

The request-local `<|think_off|>` marker is supported by the existing custom
Qwen template. It closes thinking before schema-constrained generation without
changing the shared template. Pin and reverify that template when the runtime
or model changes. Source instructions and same-name identity handling remain
separate qualification gaps; development results cannot establish held-out
performance.

This revision accepts at most 96 lexical tokens per prepared passage. The
source-span grammar grows quadratically, so longer inputs require a different
qualified approach rather than truncation. The complete passage remains the
supporting span. Repeated literal text can have several distinct offset
alternatives; the model must select its intended occurrence, and source
presence alone does not establish semantic support.

Because the grammar contains source text, its Outlines cache is working
material. Before a run, start the idle daemon with `OUTLINES_CACHE_DIR` pointing
to a manifest-listed cache directory inside the Mini's excluded pilot store.
Verify the active engine's open cache files use that directory. After the run,
stop that daemon to release prompt state and cache handles, restore normal
startup without the override, and restore the existing ensure LaunchAgent.
Keep the cache under the original collection deadline. This does not authorize
private inputs or change the model artifact, template, account or provider.
