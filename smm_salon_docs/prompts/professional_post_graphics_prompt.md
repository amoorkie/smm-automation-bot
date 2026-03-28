# Professional Post Graphics Prompt - Hair Master Exact Salon Visuals

This file is the canonical source of truth for expert post graphics. It applies to `/topic` and any future topic-like visual mode that needs the same salon language.

## Visual Contract

The image must feel like a real iPhone photo from the same small salon seen in the reference images.

The image does not need to be only an interior shot. The planner may choose:
- `exact_salon_room`
- `exact_salon_closeup`
- `neutral_nonhuman_object`

Selection rules:
- Use `exact_salon_room` when the topic benefits from a recognizable room shot and the interior itself should carry the context.
- Use `exact_salon_closeup` when the topic is better shown through a tighter crop, a working corner, a tool, a shelf, a mirror detail, or another close detail inside the same room.
- Use `neutral_nonhuman_object` when the topic is stronger as a clean object-only salon visual and does not need a room read.

## Exact Salon Rules

When the planner selects an exact-salon mode, keep the room locked as closely as possible:
- same floor pattern
- same mirror shapes and placement
- same chairs and their relative positions
- same wall texture and overall architecture
- same sense of layout and spacing

Allowed variation:
- camera angle
- crop
- distance
- focus point
- closer shot inside the same room

Not allowed:
- inventing a different salon
- redesigning the architecture
- changing the furniture style
- swapping the room for a luxury showroom
- turning the scene into a studio render

## Look And Feel

The image should feel:
- realistic
- slightly imperfect like a normal phone photo
- close to the real interior
- calm and clean, but not polished into a fake ad

Do not make the image feel like:
- a portfolio shot of a finished hairstyle
- a before/after card
- a banner
- a glossy synthetic beauty render

## Topic Subjects

Use the topic to choose the main object or action. Good subjects include:
- care products
- brushes, combs, bottles, diffusers, dryers, heat tools
- hands of a master in a neutral process moment
- towel, table, shelf, mirror, working corner
- care and heat-protection details
- routine and post-visit aftercare details

Hair may appear only as secondary context. The hero should not be a finished hairstyle, a portrait, or a salon promo pose.

## Master Prompt

```text
Create one realistic smartphone photo for a professional hair master post.

Choose the best planner mode first:
- exact_salon_room for a recognizable room shot
- exact_salon_closeup for a tighter detail inside the same room
- neutral_nonhuman_object for an object-only salon visual

If you use an exact-salon mode, keep the room almost identical to the attached references.
Do not redesign the salon.
Do not invent new architecture.
Do not change the floor pattern, mirror shapes, chair placement, or furniture style.

The scene should feel like it was photographed on an iPhone in this exact salon, not in a similar salon and not in a perfect studio.

When color accents are useful, prefer the salon brand palette with main colors `#CE6BD6` and `#A21A92`.
Use these colors carefully in products, towels, accessories, reflections, or subtle decor accents instead of random accent colors.

The safest variation is a different camera angle, crop, distance, or focus point inside the same salon.
If the topic needs a subject detail, make a closer shot inside the same room instead of creating a new location.

Treat seasonal decor, certificates, posters, tinsel, and random small objects as incidental details.
Do not force them into every image.

This is not a portfolio image of a finished hairstyle.
This is not a before/after image.
This is not an ad banner.

Allowed main subjects:
- care products
- styling and care tools
- a working corner
- hands of a master in a neutral process detail
- towel, brush, comb, bottle, diffuser, thermal protection context
- calm salon routine

Hair may appear only as secondary context.
Do not make a finished hairstyle, haircut, coloring result, or client portrait the main hero of the image.

Style rules:
- realistic phone-camera perspective
- natural light behavior
- believable textures
- slight everyday imperfectness
- restrained use of brand accent colors `#CE6BD6` and `#A21A92`
- no glossy ad finish
- no uncanny generated perfection
- no heavy retouch
- no infographic look
- no text on image
```

## Runtime Mapping

Use this document for:
- `topic_image_generation`
