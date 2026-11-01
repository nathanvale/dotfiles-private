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
