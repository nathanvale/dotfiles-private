# Audio template (proposed, not sent in this release)

Studio type `audio`, `audio_format=deep_dive`, `audio_length=short` unless the
manifest preferences say `default` or `long`. Source ids are the current bound
pack sources.

Instructions:

- Two conversational hosts tell one request story through the pack.
- Pause for a prediction before each answer.
- End with one tiny task the listener can do in five minutes.
- Keep deeper material optional.
- Carry the role marker `lp:PACKID:audio:NONCE` in the instruction field
  (gate G4 checks it reads back; the listener checks it is not spoken).
