# Topic-Like Modes Registry

This registry groups every canonical prompt doc used by the topic-like content system.

## Current Modes

- `/topic`
  - text: [professional_post_text_prompt.md](./professional_post_text_prompt.md)
  - visuals: [professional_post_graphics_prompt.md](./professional_post_graphics_prompt.md)
  - visuals library: [professional_post_graphics_variants.md](./professional_post_graphics_variants.md)

- `/stories`
  - manifest: [stories_manifest_prompt.md](./stories_manifest_prompt.md)
  - visuals: [stories_visual_prompt.md](./stories_visual_prompt.md)

- `/creative`
  - manifest: [creative_manifest_prompt.md](./creative_manifest_prompt.md)
  - visuals: [creative_visual_prompt.md](./creative_visual_prompt.md)

- `/slider`
  - manifest: [slider_manifest_prompt.md](./slider_manifest_prompt.md)
  - visuals: [slider_visual_prompt.md](./slider_visual_prompt.md)

## Shared Rules

- All topic-like modes use `title`, `brief`, and `tags` as the source input.
- All manifests return structured JSON for deterministic composer/runtime handling.
- All visuals should stay in the hair salon domain.
- `published` in the source tables means manual approval in the bot, not external posting.

## Content Scope

- hair care
- scalp and roots
- home routine
- after-salon maintenance
- product choice
- heat protection
- client habits
- light salon humor for creative mode

## What Not To Do

- no wigs as a core theme
- no heavy beauty editorial drift
- no finished hairstyle hero shots for expert graphics
- no overlong text blocks inside image prompts
