# Browser Authorization

A connector or integration that needs browser consent (OAuth, device code, or
another provider-issued link) is an agent-managed handoff. Nathan opens one
link and consents. The agent owns every terminal step, diagnosis, check,
cleanup, and the continuation of the waiting task.

## Flow

1. Find the supported login command through the connector's installed skill
   route or the CLI's `--help`. Do not copy a versioned cache path or a
   provider command into instructions.
2. Start the login on the task execution host, in an agent-owned PTY, with the
   no-browser variant when the host cannot open Nathan's browser. Prefer a
   provider remote or device flow over a localhost redirect.
3. Keep that process alive until it exits. It owns the callback listener.
4. Identify and validate the provider authorization or verification consent
   URL, then send Nathan that exact value; exclude callback URLs, callback
   codes, and raw terminal output. For a device flow, include the minimum user
   code where required. If the consent URL cannot be distinguished safely,
   use the human terminal fallback. Add only provider, account, and reason.
   Keep the link private to the session and out of committed or published
   artifacts; terminal and session capture may hold it.
5. After consent, verify live (see Proof). Then resume the waiting task inside
   its existing authorization.
6. Clean up: stop the login process and any forwarding route, whatever the
   outcome (done, cancelled, or timed out).

## Remote return

A localhost redirect reaches the machine that runs the browser, not the
execution host. When the two differ:

- Read the callback host and port from the provider URL's `redirect_uri`. The
  login process binds them on the execution host; the forwarded port must be
  those exact values.
- Prefer a temporary authenticated SSH loopback forward between the two
  machines, bound to loopback only, for that one port.
- Tailscale or WireGuard membership alone does not make a loopback redirect
  reachable. Forward the port.
- From the browser machine, check that the forwarded port answers before
  sending the link. A route that is not proven is not sent.
- Bound the forward by the login lifetime: close it on completion,
  cancellation, or timeout.
- When the provider forbids remote return or the browser must be on the same
  machine, name that limit and the smallest human action (for example, open
  the link on the execution host). Never send a link that cannot return.

## Proof

Report each state separately; each needs its own evidence.

| State | Evidence |
|---|---|
| Consent | The login command's success result |
| Grant stored | The connector's login completion result or another explicit connector-owned storage receipt; auth status showing only a present index (`vaultIndex` present, grant unknown) is configuration evidence, not a stored grant |
| Live authenticated | An admitted authenticated provider read succeeds; it need not name a principal |
| Schema and tool access | Live schema or tool-access call; reported on its own |
| Scoped resource access | A read of the named resource succeeds |

- Choose the live check the waiting task needs: one admitted, known, read-only
  call, or the connector's tool-access call. A broken schema listing is not a
  prerequisite for it.
- A failed check after consent says which check failed. If an admitted
  authenticated read succeeds, the grant works: do not send Nathan through
  consent again. Report invalid JSON or tool shape as a schema/parser failure,
  separately from catalogue drift and authentication.
- Continue only admitted, known operations. Newly advertised tools stay
  outside the approved route.
- Resume the waiting task once the live checks it needs pass.
- A failed auth or schema check never authorizes replaying a mutation. An
  external mutation with an unknown outcome follows the connector's own
  recovery contract: inspect first, retry only when live state shows no effect.

## Limits

- The agent cannot click the consent page. Nathan does.
- A connector whose login refuses a non-human terminal, or hides the URL from
  the agent, is a runtime gap. Report it with its cause code. Fall back to
  asking Nathan to run the command, as that connector's skill says.
