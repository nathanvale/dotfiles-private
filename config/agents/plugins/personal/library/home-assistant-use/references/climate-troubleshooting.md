# IR climate troubleshooting

Separate the command source, reported state and physical response. Sensibo,
HA and HomeKit can agree on On while an IR-controlled AC only beeps and keeps
its flap closed. Do not repair that mismatch by inventing an assumed state,
counting an API acknowledgement as success or repeatedly sending Power.

Read the owner's current physical observation before each arranged test. A
manual change supersedes a captured earlier state; preserve it rather than
blindly restoring old settings. If physical tests are excluded, inspect states,
logs, remote configuration and documents without power, mode, temperature or
fan commands. End repeated failed trials when they add no new evidence.

For an authorized comparison, isolate one variable and send one command.
Compare the original remote with the vendor app, then HA/Home if needed. A
failure with the original remote weakens an integration-only explanation.
Distinguish starting a mode from Off, changing mode while running and restarting
in the same mode. Record target, fan, elapsed interval, flap, airflow and named
indicators. A beep proves reception, not acceptance or operation.

Check IR positioning and the configured remote profile through the vendor's
documented route. Auto Detect listening or returning to the settings screen
does not prove a profile was changed; retain its actual result. Resolve indoor,
outdoor and remote models from supplied labels before requesting them again.
Check whether indoor units share an outdoor unit and read the exact system's
operating restrictions. Do not assign a fault code from a beep count, lamp
colour or a different model's manual.

Consult current manufacturer and vendor documentation. Distinguish compressor
restart protection, standby restrictions and observed fan/flap behavior. Treat
remote Test Run as a commissioning function unless the exact manual documents
an owner procedure. Arrange an isolator reset separately after identifying the
correct isolator, shared equipment and any diagnostics that must be preserved.
Keep factory resets, installer settings, forced cooling, wiring, refrigerant
and firmware work outside an ordinary control trial.

For service escalation, produce a short sendable report with exact equipment
models, the normal-use symptom, reproducible tests, unresolved observations and
one clear request. Attach original video and labels, distinguishing derived
stills from originals. Keep the detailed test log privately linked; honor a
request for a brief email or one-page PDF. Sending to the verified service
recipient requires Nathan's explicit message authorization. Record Sent
read-back separately from recipient acknowledgement and physical repair.

Check current references rather than treating them as a diagnosed cause:

- [HomeKit Bridge](https://www.home-assistant.io/integrations/homekit/)
- [Sensibo integration and polling](https://www.home-assistant.io/integrations/sensibo/)
- [Sensibo IR response troubleshooting](https://support.sensibo.com/troubleshooting/ac-does-not-respond-to-sensibo/)
