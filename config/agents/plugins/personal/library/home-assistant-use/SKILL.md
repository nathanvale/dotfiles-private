---
name: home-assistant-use
description: Inspect, control or troubleshoot Home Assistant and Apple Home; align device names, diagnose climate and HomeKit sync, capture logs, or inspect the home router for connectivity faults.
---

# Home Assistant

Resolve the requested home, devices and operation from current evidence. Treat
planning, diagnosis and audits as read-only; an instruction update does not
authorize live automation changes.

## Choose the work

- For calm household automation or control design, read
  [calm operation](references/calm-operation.md).
- For faults, unreliable controls or a setup audit, read
  [troubleshooting](references/troubleshooting.md).
- For Sensibo or IR-controlled AC failures, read
  [climate troubleshooting](references/climate-troubleshooting.md).
- For a specific device action, resolve its live identity and read its current
  state before acting. Perform the requested action once, then read back its
  state so the original setting is available for a scoped rollback.

## Access and ownership

For HA and the home router, use Codex's native browser controls with Nathan's
existing personal Chrome session first. Prefer DOM controls; fall back to
computer-use controls in Chrome when the page cannot be operated through DOM.
Read [browser access](references/browser-access.md) for address discovery,
sign-in and Apple Home or iPhone Mirroring comparisons. Discover existing HA
connectors for repeatable structured operations; use only their observed schemas.
Adding a connector or changing authentication remains separate setup work.

Use configured credential providers without displaying tokens or raw
credential-bearing configuration, including secrets.yaml and connector setup.
Resolve a failed connection before trying device actions through a different
identity or broader permission boundary.

Find household decisions in the configured vault's existing home project or
system note. Treat absent notes as a recovery gap: use explicit conversation
decisions, identify unresolved choices, and never represent them as deployed.
Keep schedules, entity IDs and live backlog out of this reusable skill.

Identify devices by area, domain and stable ID, not friendly name alone.
Match the requested control to its actual entity domain and ID when names
overlap. Inspect existing automations in HA, Apple Home and the vendor app
before changing their owner;
preserve working physical controls and avoid duplicate device exposure.

## Change and verify

Before an authorized change, record the exact affected configuration and a
scoped rollback. Preserve entity IDs, unrelated automations and room members.
Rename or reassign an area only after checking area-targeted actions.

Treat lights, climate, blinds, scenes and scripts as physical effects. Arrange
actuating or disruptive tests explicitly.

After a write, read back. A service acknowledgement proves acceptance, not
physical effect. Report unavailable, optimistic or unknown feedback honestly;
ask for physical confirmation where needed. Inspect uncertain outcomes before
retrying. Stop on an unresolved target or unexpected household effect.

Report what changed, what was observed, remaining uncertainty and one next
action. Distinguish proposed, configured, enabled and physically tested.
