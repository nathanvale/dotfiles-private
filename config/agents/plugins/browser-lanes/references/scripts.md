# Authored page scripts

Use JavaScript for an authorized task on the exact admitted page through the
assigned adapter. Keep browser entry, identity, and custody with lane-entry.md.
Read current `browser-lane --help` for the executable plan contract.

## Script contract

Keep reusable code in a linked `.js` file with purpose, input validation,
effects, returned evidence, repeat safety, and timeout behavior in its recipe.
Store task inputs privately and encode them as JSON values when preparing an
invocation. Keep passwords, cookies, tokens, and authentication actions with
the existing human/credential owner. Return bounded task assertions, not whole
page or storage dumps.

For plan adapters, represent the script as a zero-argument function source,
optionally async. Capture validated JSON task inputs in that function. The
public runner snapshots the private JSON plan before executing it. Read the
script file as data while constructing JSON; never interpolate it into shell
code or evaluate it in the host process.

| Assigned adapter | Page script entry |
| --- | --- |
| Playwright | `browser-lane playwright` with schema-2 `evaluate` action |
| Puppeteer | `browser-lane puppeteer` with schema-2 `evaluate` action |
| Agent Browser | `browser-lane agent-browser` with `eval -b BASE64`; encode the invocation expression from the private source file |
| Chrome DevTools | `browser-lane run` with `chrome-devtools.evaluate_script`; discover the installed schema and pass a private function file through MCPorter's documented file argument |

Plan example, with synthetic data only:

```json
{"schema_version":2,"actions":[{"command":"evaluate","args":["() => ({heading: document.querySelector('h1')?.textContent ?? null})"]}]}
```

Agent Browser's batch accepts single-line command strings. Its installed
`eval -b` accepts base64: encode the UTF-8 invocation expression, such as
`(<function source>)()`, without line wrapping, then pass `eval -b BASE64` as
one batch item. Base64 is transport encoding, not redaction; keep source and
outputs private. DevTools receives fresh page selection from the lane, never a
caller-provided page ID. Full host `run-code`, browser attachment, and direct
profile access are outside this script interface.

## Effect and evidence boundary

These are trusted task scripts, not isolated untrusted programs. An in-page
script can trigger network requests, navigation, or delayed effects. URL
checks at invocation boundaries cannot guarantee that none occurred. Keep code
within the approved origin, task, and page effects. Use application state to
verify a write; a return value alone is insufficient.

Check returned assertions explicitly. A returned `false` or `{ok:false}` is
result data; throw an error when a failed assertion should stop the plan.
Playwright reports thrown and rejected scripts as command failures and stops
remaining actions. The CLI help owns exit codes and retirement behavior.

A timeout, thrown error, or disconnected adapter may leave a page mutation or
scheduled script running. Inspect the same target before retry or reset. Stop
when effects cannot be established. The plan budget bounds the adapter process,
not every future effect scheduled in a page. Keep scripts finite and await
their work rather than leaving timers or background promises behind.

## Qualification policy

Inspect existing capability evidence before requesting a fixture detour. Reuse
evidence only when it identifies the assigned adapter and version, relevant
runner and helper bytes, transport and extension payload, required operation,
observed result, page binding, and cleanup limit, and all remain applicable to
the installed route. A plugin version or shell-entry hash alone is
insufficient.
Synthetic public-command tests prove only the forwarding or refusal they
observe; prior read qualification does not prove a new operation or live
application behavior.

Treat missing identity fields, changed bytes or payloads, incompatible
transport, an untested required operation, or unresolved result or cleanup as
a qualification gap for the affected capability. Run a bounded harmless
fixture check only for that gap. Explain why the fixture is needed before
asking the human to change admission. Record a small private receipt with the
evidence identity, actual output, binding result, and cleanup limit. Never count
qualification as a competition attempt.

Fresh lane health and exact task-page readiness are required before live work
even when qualification evidence is reused. Qualification establishes an
installed capability, not current permission, application correctness, or a
safe baseline.
