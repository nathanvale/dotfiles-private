# Mac Storage

Preservation-first investigation and cleanup.

## Discover

- Start read-only. Record `df -h /`, Trash size, and local Time Machine
  snapshots separately.
- Use CleanMyMac Space Lens as candidate discovery and an action receipt.
- Inspect its current logs with:

  ```sh
  rg -n 'SpaceLensScanTask|SpaceLensScanning|spaceLens|CleaningCore:FileRemover|RemovalTask|trackCleanComplete' \
    "$HOME/Library/Group Containers/S8EX82NJP6.com.macpaw.CleanMyMac5/Library/Logs/CleanMyMac_5" \
    | tail -n 200
  ```

- Record scan start, finish, duration, reported total, and result status.
- Treat a `partial` result as incomplete coverage.
- Treat logged cleanup actions as receipts, not proof of current absence or
  reclaimed space.

## Verify

- Measure each candidate directly on the current filesystem.
- Identify overlap before adding candidate sizes.
- Classify data as regenerable, re-clonable, backed up, or unique.
- For Git repositories, prove clean state, reachable remotes, no local-only
  commits or branches, and no stashes before calling them re-clonable.
- Check open files and process working directories before removing dependencies
  or archived worktrees.
- Verify the intended external Time Machine backup is mounted and contains the
  candidate. Treat local snapshots as retention, not external backup proof.
- Distinguish moved-to-Trash bytes, permanently removed bytes, and space
  currently reported free. Account for APFS snapshots delaying reclamation.

## Decide

- Present each exact path, measured size, active use, recoverability evidence,
  and proposed action.
- Ask Nathan before stopping processes, moving data to Trash, emptying Trash,
  or deleting data.
- Stop without mutation when active use, ownership, recoverability, or backup
  evidence is unresolved.

Complete when every proposed target has independent current evidence and the
reported reclaimed space distinguishes deletion from observable free space.
