# Calm operation

Keep ordinary home behaviour deterministic. Use agents for bounded setup and
diagnosis, not as a requirement for every motion or arrival event. Prefer one
automation owner, with Apple Home, Siri and physical controls as familiar
interfaces. Inspect existing ownership before proposing a transfer.

## Design decisions

- Separate darkness from household quiet hours. Use HA's configured location
  and Sun integration for daylight; use the agreed bedtime routine for quiet
  mode. Sunrise does not establish that everyone is awake.
- Give buttons stable meanings and a dial one purpose. Preserve explicit
  manual choices over automatic scenes. Define how a manual override ends.
- Distinguish a motion sensor from a button remote. Motion establishes movement,
  not identity, arrival or an empty house. Phone absence alone does not prove
  nobody is home. Ask about unresolved occupancy behaviour before activation.
- Make notifications actionable and bounded. Bind approval to the described
  action and departure instance, expire stale actions, reject repeat execution,
  and let no response mean no change.
- Restore only a valid snapshot belonging to the approved departure. Preserve
  devices changed by occupants while away. Define restart persistence, snapshot
  expiry and the fallback for missing data before enabling restoration.
- Evaluate quiet mode and the approved arrival conditions before restoration.
  A short absence is not permission to override sleeping occupants.
- Base comfort decisions on available, fresh indoor temperature readings and
  agreed limits. Treat unknown readings as unavailable, not zero. Keep outside
  weather as context unless a specific rule uses it.
- Treat blind-position restoration as unsupported until the device's feedback
  and positioning capability are verified. Do not equate an optimistic state
  with a measured position.

## Motion lighting

Agree the sensor coverage, lights, brightness, no-motion timeout and retrigger
behaviour. Track which lights the automation itself activated; a timeout should
not switch off an independently or manually lit room. Check the outbound and
return path in person before calling nighttime coverage tested.

## Calm status and proof

Expose only useful explanations: quiet mode, departure approval, snapshot age,
arrival eligibility, last action or skip reason, and unavailable devices.
Keep notification noise low and offer a clear automation pause that preserves
manual control. A status screen is optional, not a requirement for every edit.

For each implemented journey, test the happy path, no-response path, occupied
home, quiet mode, manual override and unavailable-device cases that apply.
Include restart and stale-snapshot tests when persistence is claimed. Prefer
non-actuating checks first; get approval for physical or disruptive tests.

Consult current official docs for implementation syntax:
- [Sun](https://www.home-assistant.io/integrations/sun/)
- [Actionable notifications](https://companion.home-assistant.io/docs/notifications/actionable-notifications/)
- [HomeKit Bridge](https://www.home-assistant.io/integrations/homekit/)
