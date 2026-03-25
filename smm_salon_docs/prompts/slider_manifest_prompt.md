# Slider Manifest Prompt

This prompt defines the structured plan for a short `slider` carousel.

## Purpose

Generate a 3 to 5 slide instructional carousel for general hair care, salon habits, or aftercare.

## Input

Use only:
- `title`
- `brief`
- `tags`

## Output Contract

Return JSON only.

Required fields:
- `mode`: `"slider"`
- `format`: `"1080x1920"`
- `slides`: ordered array with 3 to 5 slide objects
- `slide_count`: number of slides
- `topic_angle`: the chosen angle from the source topic
- `visual_mode`: one of `exact_salon_room`, `exact_salon_closeup`, `neutral_nonhuman_object`
- `slide_title_style`: short title pattern
- `slide_body_style`: short instructional body pattern
- `asset_notes`: what the image set should show
- `negative_notes`: what must not appear

## Slide Structure

Suggested structure:
- slide 1: hook
- slide 2: simple explanation or first step
- slide 3: second step or common mistake
- slide 4: short reinforcement or exception
- slide 5: closing reminder if needed

## Writing Rules

- Keep each slide short.
- Avoid long paragraphs.
- Prefer plain language and clear sequencing.
- Make the slide set useful even if the reader only skims it.

## Good Fits

- quick care instruction
- product choice guide
- mistake checklist
- after-salon maintenance
- scalp and roots note
- heat protection mini-guide

## Runtime Mapping

Use this document for:
- `slider_manifest_generation`
