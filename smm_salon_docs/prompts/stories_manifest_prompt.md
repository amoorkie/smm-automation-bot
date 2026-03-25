# Stories Manifest Prompt

This prompt defines the structured plan for a single `stories` slide.

## Purpose

Generate a short one-slide story about general hair care, salon habits, or aftercare.

## Input

Use only:
- `title`
- `brief`
- `tags`

## Output Contract

Return JSON only.

Required fields:
- `mode`: `"stories"`
- `format`: `"1080x1920"`
- `headline`: short, clear, 2 to 7 words
- `subheadline`: one short supporting line
- `topic_angle`: the specific angle chosen from the source topic
- `visual_mode`: one of `exact_salon_room`, `exact_salon_closeup`, `neutral_nonhuman_object`
- `layout`: a compact layout plan for one vertical slide
- `text_blocks`: an ordered list of short text fragments
- `asset_notes`: what the image model should show
- `negative_notes`: what must not appear

## Writing Rules

- Keep the slide short.
- Make the takeaway obvious in one glance.
- Prefer a practical micro-tip, a checklist, or a short product grouping.
- Do not write like a lecture.
- Do not produce final marketing copy in the manifest.

## Good Fits

- top 5 basic care items
- one quick routine
- after-salon habit
- scalp and roots note
- heat protection reminder

## Runtime Mapping

Use this document for:
- `stories_manifest_generation`
