---
name: browser-use
description: Run one bounded, attended, read-only browser task in regular Google Chrome with the dedicated automation profile. Use when Nathan must visibly complete sign-in before an agent resumes one approved read. Only for the dedicated automation profile outside Browser Lanes; not for declared profile lanes.
---

# Browser Use

Use Agent Browser directly for one attended, read-only task. This skill has no
Browser Lanes dependency.

## Fixed boundary

- Use regular Google Chrome only:
  `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.
- Use only this dedicated Chrome user-data directory:
  `/Users/nathanvale/.local/share/my-second-brain-playground/browser-automation/profiles/quiet-agent-browser`.
- Never read, attach to, copy, enumerate, or otherwise use Nathan's daily
  Chrome profile.
- Do not use Chrome for Testing, `--auto-connect`, `--state`, `--restore`,
  credential providers, extension paths, browser-lane, or Browser Lanes.

## Before opening a service

Obtain Nathan's explicit approval of the exact ordinary URL, read-only result,
and one-run boundary. Create a mode-`0700` private run directory and a
mode-`0600` receipt. Record the URL, task, fixed profile and Chrome paths,
Agent Browser version, namespace `browser-use-attended-auth`, and session
`slice-3`.

Before launch, verify only that the fixed profile is a non-symlink directory,
record its metadata, verify Chrome exists, and record task-owned Agent Browser
process identifiers without arguments. Any uncertain profile, target, or
task-owned custody stops the run. Do not create, repair, copy, or delete a
profile after a stop.

## Visible handoff

Start the exact approved URL in a visible, pinned session:

```sh
agent-browser --profile /Users/nathanvale/.local/share/my-second-brain-playground/browser-automation/profiles/quiet-agent-browser \
  --executable-path /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --headed --namespace browser-use-attended-auth --session slice-3 --pin-tab \
  --no-auto-dialog open "$TARGET_URL"
```

Record the pinned-tab identifier and current URL. At authentication, pause
visibly. Nathan alone operates any extension, passkey, OTP, CAPTCHA, native
dialog, account choice, trust prompt, or recovery step. Do not inspect its
contents, request a credential or code, take a sensitive screenshot, or
continue until Nathan explicitly returns the same visible tab.

## Resume once

After return, re-observe and record the pinned tab identifier and URL. If it
is gone, changed, duplicated, hidden, or cannot be shown to be the handback
tab, stop without retrying. Perform only the approved low-risk read: no click,
submit, download, mark, reaction, message, setting change, or other write.
Retain only the non-sensitive result.

## Compare and retire

Compare before and after profile metadata, namespace/session, pinned-tab
identifier/URL, and task-owned process identifiers. State permitted changes
and unknowns; never infer account state from inventory.

Retire only the task-owned session with `agent-browser --namespace
browser-use-attended-auth --session slice-3 close`. Never use `close --all`,
delete the profile, clear cookies, alter extensions, or close another Chrome
window. Take one delayed task-owned process check. Unproven cleanup stops the
run; do not repair it.

## Stop boundary

Stop immediately for missing approval, failed custody, a wrong or changed
target, an authentication or native-dialog action Nathan has not completed,
a write-capable surface, lost handback, unexpected effect, or uncertain
tab/session cleanup. Preserve only permitted metadata and ask one precise
recovery question.
