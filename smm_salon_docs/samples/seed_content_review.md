# Seed Content Review

These seed lists were built for three separate source tables:
- `story_topics`
- `creative_ideas`
- `slider_topics`

The matching canonical prompt docs live under:
- `smm_salon_docs/prompts/stories_manifest_prompt.md`
- `smm_salon_docs/prompts/stories_visual_prompt.md`
- `smm_salon_docs/prompts/creative_manifest_prompt.md`
- `smm_salon_docs/prompts/creative_visual_prompt.md`
- `smm_salon_docs/prompts/slider_manifest_prompt.md`
- `smm_salon_docs/prompts/slider_visual_prompt.md`

## Clusters Used

`story_topics`
- routine and washing
- scalp and roots
- product choice
- heat protection
- post-salon aftercare
- seasonal care
- balance and not overloading hair

`creative_ideas`
- client phrases and appointment humor
- salon life and timing
- tools and products as playful characters
- hair behavior jokes
- honest home-care advice with a light tone

`slider_topics`
- wash and dry routine
- product selection
- color care
- after-salon maintenance
- heat protection
- hair-type specific guidance
- weekly care plans

## Duplicate Pass

Near-duplicate ideas were intentionally collapsed instead of repeated in different wording. The main cases were:
- shampoo frequency and scalp freshness
- mask versus conditioner comparisons
- thermoprotection and hot styling warnings
- post-salon care and result preservation
- volume and root freshness topics

This kept the lists broad enough for repeated publishing without making the queue feel repetitive.

## Seed Shape

Each CSV row is intentionally short and maps to:
- `id`
- `title`
- `brief`
- `tags`
- `priority`
- `status`
- reservation and publish tracking fields left blank for runtime

`status` is seeded as `ready` for every row.

The shared visual policy for topic-like expert graphics is:
- exact salon when the room must be recognizable
- closeup when the topic is better shown by a detail inside the room
- neutral non-human object when the topic is better as a clean object scene
