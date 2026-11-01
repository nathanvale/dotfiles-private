---
name: jev
description: "Call TypeSafe JEV with named choice or noul questions through shared Connectors custody, or inspect an uncertain inference receipt."
---

# JEV

Use this shared connection for TypeSafe model discovery and paid inference.
Keep application policy, redaction and question wording with the calling skill.
For question design, read the installed official `typesafe-ai` skill. This
connector owns credential custody and execution; its probabilities grant no
authority to change another application.

## Connect

Resolve the front door from this loaded skill directory. Calling skills use
the same packaged connection. Inspect public help and schema:

```sh
SKILL_DIR="<directory containing this SKILL.md>"
CONNECTORS="$SKILL_DIR/../../bin/connectors"
"$CONNECTORS" --help
"$CONNECTORS" schema jev
```

Register the 26-character ID of an existing 1Password item in `API Credentials`
whose `credential` field holds the TypeSafe API key:

```sh
"$CONNECTORS" auth configure jev --input '{"item":"<item-id>"}'
"$CONNECTORS" auth check jev
"$CONNECTORS" run jev list_models
```

Configure records the item reference. Check proves custody readiness only.
Model listing contacts TypeSafe and returns available models and aliases.
Credential values stay inside the internal Provider; environment key aliases
and host overrides have no effect.

## Infer

Obtain authority for the data and paid request before sending it. Pin a
versioned model returned by discovery. Choose a stable `requestKey` identifying
this exact intended inference and retain it with the caller's private inputs:

Prepare a private JSON object containing `requestKey`, `model`, `state` and
named `questions`. Use an existing owner-only regular UTF-8 file with mode
`0600`, or pipe it through closed non-TTY stdin:

```sh
"$CONNECTORS" run jev system_one --input-file /absolute/private/request.json
cat /absolute/private/request.json | "$CONNECTORS" run jev system_one --input-file -
```

For example, a synthetic request file can contain:

```json
{"requestKey":"synthetic-fruit-1","model":"jev-1.14.0","state":{"text":"An apple"},"questions":{"fruit":{"type":"choice","criteria":{"apple":"An apple","pear":"A pear"}},"apple_present":{"type":"noul","instructions":"Does the text describe an apple?"}}}
```

Use exactly one of `--input-file` and `--input`. Keep private evidence out of
inline arguments and shell history. Both private forms refuse invalid UTF-8,
non-object JSON and input above 256 KiB before custody or Provider capability.
Stdin must close within five seconds. The file route refuses symlinks, special
files, wrong ownership and any mode other than `0600`. Private input is
available on ordinary `run`, not write preview/apply.

The JEV transport stages one private copy under Connectors state and uses
MCPorter's file argument plus stdio. Payloads do not enter child-process
arguments. Normal completion removes the copy; a forced process termination
can leave a `0600` orphan. The caller's source file remains caller-owned.
These local guarantees do not establish the provider's retention, logging or
training terms. Those account and route terms remain unqualified here.

Read the typed answers, full choice distributions, confidence, usage and
`requestId` from `result.data`. Errors carry fixed causes rather than provider
body excerpts. This route accepts text/structured state and choice/noul only:
256 KiB serialized local input, at most 64 nested levels, finite numbers,
1 through 255 criteria per choice. Vendor token limits still apply; this is
not a tokenizer. Assets, score, box and long-context opt-in are outside this
initial route.

## Unknown outcome

Every inference reserves a private digest receipt before dispatch and claims
one send before HTTP. The HTTP client makes one attempt, including on 429 or
529. A successful duplicate key returns the completed receipt with `noCall`,
not a new inference or retained answers. A key with different input refuses.
A reserved, sending or unknown key refuses another send.

```sh
"$CONNECTORS" recover jev
"$CONNECTORS" recover jev --run <run-id>
```

Inspect the local receipt. TypeSafe documents no remote request lookup or
idempotency mechanism here, so inspection cannot settle an unknown outcome or
billing. This route offers no unlock or replay override. Do not manufacture a
new key to work around a blocked attempt. Report the unknown and return to the
caller for a separately considered new request.

Complete a call only when its envelope reports a verified answer or an explicit
no-call receipt. Keep configured, fixture-tested, authenticated, live model read
and paid inference proof distinct. Read [research and limits](references/research.md)
when changing the schema, custody or replay contract.
