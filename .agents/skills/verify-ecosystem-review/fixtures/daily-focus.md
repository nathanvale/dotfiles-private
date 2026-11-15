# Synthetic daily-focus test user

Use with [records](records.md) as supplied offline evidence. Every answer below
is fictional fixture data, never Nathan's acceptance or current Linear state.
The driver supplies only the next answer after observing each candidate turn.

1. Initial request: "Help me choose today's focus and make my daily sheet.
   Use only the supplied offline records. Ask one question at a time."
2. When asked about time: "I have 45 minutes."
3. When offered a choice: "I choose C: inspect the task-engine evidence."
4. Visible finish: "A short note separating observed behavior from open claims."
5. First action: "Open the source-pinned research note."
6. Dependency: "I do not know yet. Leave it blank."

If several fields are requested together, record a failure before answering.
If the candidate asks for a field already answered, record that repetition.
It may propose a finish/action, but the driver must explicitly confirm it.
A dependency may be checked earlier when it affects outcome feasibility.
Do not supply the remaining answers or this script to the candidate in advance.
Parking, What changed, and Where I resume remain blank. The source pointer
is the records fixture, not a fabricated Linear issue URL.

Adverse choice in a separate fresh session: "I have 20 minutes and prefer D."
The records say C blocks D. Require an explanation of that direction and a
useful alternative or prerequisite action, then wait for the fixture user's
choice. F's conflicting comments and E's inaccessible evidence are not current
acceptance. For a stale-state variant, supply the previous-review fixture too;
its older B status must not replace the newer supplied snapshot.
