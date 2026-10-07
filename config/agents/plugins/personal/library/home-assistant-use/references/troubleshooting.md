# Troubleshooting and audit

Start with one affected journey and an expected versus observed result. Read
current state and a relevant recent trace or log before proposing a fix. Keep
logs scoped and redact credentials and unrelated household information.

## Locate the failing layer

| Observation | Next read-only check |
| --- | --- |
| HA itself is unreachable | Configured endpoint, host/container availability and network route |
| HA works, agent connection fails | Existing connector identity, documented schema, permissions and exposure |
| Device fails in HA and Home | Device integration, availability, battery/power and vendor status |
| Device works in HA but not Home | Bridge membership, pairing, LAN discovery, advertised address and reachable port |
| Automation does not run | Trigger history, conditions, enabled state and trace skip reason |
| Device changes unexpectedly | Competing HA/Home/vendor rules, manual input and stale notification actions |
| Remote buttons differ from the plan | Exact model, current button events and existing assignments |

An empty exposed surface does not establish that devices are absent. Inspect
exposure and permissions without bypassing them. A successful network probe
does not prove authentication, pairing or control.

For HomeKit discovery, distinguish persistent configuration from a temporary
process. A one-off DNS-SD/mDNS network announcement may make a bridge visible
briefly without fixing discovery after a restart. Verify current discovery
metadata and network topology before proposing a durable repair.
Do not reset pairing, remove accessories, restart shared hosts or widen network
exposure as a diagnostic shortcut. Explain impact and obtain scoped authority.

## Audit result

Return a short evidence-backed list: finding, household impact, smallest repair,
verification and rollback. Separate historical observations from live findings.
Classify each result as observed, inferred or untested.

An authorized repair ends with read-back and the relevant journey test, not
just a successful command. Persistent-connection claims require an approved
restart test and a subsequent check from the household control surface.

If blocked, name the failing layer and one concrete next step. Keep unrelated
cleanup and new integrations outside the repair.
