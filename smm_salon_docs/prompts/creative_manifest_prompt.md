# Creative Manifest Prompt

This prompt defines the structured plan for a single `creative` slide.

## Purpose

Generate a short humorous or light salon creative without turning it into a hairstyle post.

## Input

Use only:
- `title`
- `brief`
- `tags`

## Output Contract

Return JSON only.

Required fields:
- `mode`: `"creative"`
- `format`: `"1080x1920"`
- `hook`: a short funny or sharp opening line
- `punchline`: the main joke or idea
- `visual_mode`: one of `exact_salon_room`, `exact_salon_closeup`, `neutral_nonhuman_object`
- `composition_note`: what should be shown visually
- `text_style`: how the text should feel
- `negative_notes`: what must not appear

## Writing Rules

- Keep the joke short.
- Use light hair-industry humor, not sarcasm that feels mean.
- Make it easy to read on a phone screen.
- Avoid dense copy or complex storytelling.

## Good Fits

- client phrases
- salon timing
- tools or products as playful characters
- daily salon life
- hair behavior jokes
- honest care advice with a light twist

## Runtime Mapping

Use this document for:
- `creative_manifest_generation`
