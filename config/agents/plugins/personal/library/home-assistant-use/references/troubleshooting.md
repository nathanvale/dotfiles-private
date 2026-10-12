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
metadata and network topology before proposing a durable repair. Compare the
live bridge and any LAN proxy's identity, address, port, configuration number
and pairing status. Inspect its supervisor and refresh behavior before calling
an existing proxy temporary or stale.
Do not reset pairing, remove accessories, restart shared hosts or widen network
exposure as a diagnostic shortcut. Explain impact and obtain scoped authority.

## Names and HomeKit sync

Agree room labels and accessory names across HA, Apple Home and the vendor app.
Match serials, device IDs and HomeKit serial/entity information before renaming
or moving accessories. Preserve stable HA entity IDs and check callers that
target areas or names. Keep existing bridge members and pairing; add only the
requested entities. Verify each app separately, including vendor room labels.

When a Home tile disagrees, compare its detailed controls with the same entity
in HA and the vendor's current state. Record observation times and account for
the integration's documented polling interval. Capture the mismatch and logs
before refreshing any client or bridge. Use naturally changing sensor readings
to check updates when physical tests are excluded.

Inspect the climate accessory type, linked fan service and advertised
configuration. A fan percentage or grouped tile summary alone does not prove
the unit is running. After an authorized type change, verify names, rooms,
controls and any affected Home scenes. Treat a scoped bridge reload and a
client reopen as recovery steps, not proof of the cause. Change one layer at a
time when diagnosing recurrence. Do not schedule restarts to mask a freeze.

## Focused diagnostic logging

Use HA's existing logger controls for an authorized capture. Read current log
levels and configuration first; preserve the scoped rollback. Check the
installed version's logger namespaces and behavior before using this recipe:

```yaml
action: logger.set_level
data:
  homeassistant.components.homekit: debug
  pyhap.accessory_driver: debug
  pyhap.hap_protocol: info
  pyhap.hap_handler: warning
```

These levels can capture HA updates, HomeKit subscriptions, characteristic
reads and event delivery, plus connection arrivals and idle timeouts. Protocol
Info does not capture every disconnect. Full `pyhap.hap_protocol` Debug records
raw traffic; keep it off for routine sync capture. Avoid broad `pyhap` or root
Debug and vendor HTTP logging that may expose API keys or pairing material.

Activate through the logging action, without a device service, bridge reload
or restart. `logger.set_level` is a runtime change. If persistence is requested,
save the same levels through the supported configuration route, preserving
existing settings, and validate HA configuration before relying on a future
start. Report persistence as configured until an approved restart tests it.

Verify a real log record from a natural update or read-only observation; an
action acknowledgement alone does not prove capture. Store raw evidence in
the existing private runtime owner with restricted permissions. Inspect Docker
rotation and HA's separate file-log retention independently; a Docker size cap
does not cap the HA file. Record when capture ends and restore the original
levels after preserving the fault. If original runtime levels are unreadable,
record that gap rather than inventing a Warning rollback.

At a recurrence, record time, room, entity and displayed values. Preserve the
state update, mapped HomeKit characteristic, client subscription and event
delivery evidence before refreshing. Compare iPhone and Mac Home when possible
to distinguish a client display issue from the shared connection. Keep the
household's endpoints, package paths, current capture and receipts in its vault
system note, not in this reusable recipe.

## Audit result

Return a short evidence-backed list: finding, household impact, smallest repair,
verification and rollback. Separate historical observations from live findings.
Classify each result as observed, inferred or untested.

An authorized repair ends with read-back and the relevant journey test, not
just a successful command. Persistent-connection claims require an approved
restart test and a subsequent check from the household control surface.

If blocked, name the failing layer and one concrete next step. Keep unrelated
cleanup and new integrations outside the repair.
