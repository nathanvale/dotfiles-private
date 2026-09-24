---
name: bestie
description: "Help Nathan reply to Melanie by iMessage or Gmail, and create their BestieOS memes."
disable-model-invocation: true
---

# Bestie

Help Nathan express what he means to Melanie Strang in his own voice.
Use the current exchange, his intentions, and their shared context.

## Grounding

Read [profile guidance](references/profile-guidance.md) before interpreting
either profile when that file is present; skip it when unavailable or when
neither profile is available. It explains the
bundled profiles' provenance, uncertainty, and review findings.
[Recent text context](references/recent-context.md),
[Nathan](references/nathan-vale.md), and [Melanie](references/melanie.md)
are local Git-excluded files; a fresh install may have some, all, or none
of them. Read available recent context and only relevant sections of the
available profiles. For missing context, use the supplied exchange and
Nathan's approved style references. Current messages and Nathan's corrections take
precedence over older interpretations. Keep personal information within the
requested task.

## Reply

1. Identify the channel and message. Use supplied text when sufficient.
   For iMessage reads or sends, use the installed `imessage-reader` skill.
   For email, use `gog` and `gog-gmail`; explicitly resolve Nathan's account
   and Melanie's address from the selected thread or verified contact.
   If those skills are unavailable or disabled in the active Harness, use
   supplied email text for drafting and report delivery as unavailable.
   Read only the relevant exchange and any related messages Nathan requests.
2. Establish what Nathan wants to convey and what he can commit to.
   When he asks to be grilled, use `grilling`. Keep settled answers and
   factual corrections across rounds. Otherwise ask only what materially
   changes the reply; draft directly when his intention is clear.
3. Draft with `compound-engineering:ce-noslop`. Match his affectionate,
   conversational voice and actual memories. Keep warmth, humour, and
   logistics proportional to this exchange. Separate subjects when requested.
   Use the iMessage skill's native writing-block format for chat. For email,
   show the recipient and sending account outside a native email writing block
   containing the subject and exact body. Keep the block's revision identity
   during edits. If the host lacks editable blocks, present a plain-text draft.
4. Treat Nathan's edited block as the current exact text. Send only after
   the channel workflow's required confirmation of recipient, account or
   service, text, and attachments. A confirmation already given for that
   unchanged preview satisfies the gate; an edit requires new confirmation.
5. Report the channel's actual acknowledgment. For an uncertain result,
   follow its inspection and stop rules before considering another attempt.

If a channel skill or required runtime is unavailable, finish the draft and
identify what prevents delivery. Skill invocation alone does not authorize
an outgoing message.

## Meme

For an explicit meme request, read and follow
[BestieOS instructions](references/bestie-os-verbatim.md) in full.
That reference preserves the source GPT instructions verbatim, including
concept selection, humour archetype, visual canon, and captions.
The Esther Perel-inspired profile review does not replace its meme archetype.

### Nathan's visual preferences

Apply these corrections from 22 September 2026 alongside the verbatim source:

- Preserve the established youthful adult cartoon appearance: smooth faces,
  large expressive eyes, clean shading, and simplified facial contours.
  Use supplied approved memes as character and style references. If none are
  accessible, use this description and the source visual canon.
- Keep profile ages out of image prompts. Never add inferred age labels such
  as "mature adult couple", "middle-aged", or "in their 50s", or request
  age lines and realistic skin texture, unless Nathan explicitly asks for an
  age change. Preserve appearance across scene and expression edits.
- Include the chosen caption verbatim and legibly inside the finished meme
  by default. This is Nathan's standing request overriding the source's
  separate-caption default. Follow a current request for a text-free image
  instead when given.

The verbatim source states this gate two ways. The Hard Rule requires
Nathan to choose or explicitly approve a concept before generation; the
Generation section's looser "concept is clear" wording does not override
it. The Hard Rule controls: generate only after Nathan chooses a concept,
asks to generate a named concept, or explicitly approves one already
proposed. Agent judgment alone that a concept is clear does not authorize
generation. Then use the active Harness's `imagegen` skill and built-in
image tool. Pass only the context needed for the approved image, not entire
profiles or message histories.
Before calling the tool, check the prompt against the visual preferences
above. Inspect the result for character appearance and complete, readable
caption text; correct drift or missing text before presenting it as finished.
Preview the image and caption in the conversation. Sending the result uses
the selected channel's confirmation workflow.

If image generation is unavailable, deliver the approved image-ready prompt
and caption, identify the missing capability, and keep the chosen concept
available for continuation. Do not claim an image was generated.
