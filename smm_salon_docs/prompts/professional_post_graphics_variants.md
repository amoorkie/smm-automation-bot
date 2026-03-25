# Professional Post Graphics Variants - Real Salon Scenario Library

This file complements the main graphics prompt and defines the supported planner modes for topic-like expert visuals.

## Shared Rules

- The image should look like a real phone photo, not a polished synthetic render.
- The salon should stay close to the reference interior.
- Hair can appear only as secondary context.
- A finished hairstyle should never become the hero of the frame.
- Seasonal decor, certificates, and random props are incidental, not required.

## Planner Modes

### `exact_salon_room`

Use when:
- the room itself is part of the message
- the topic needs a clearly recognizable salon context

Show:
- the same layout as the reference room
- the same floor pattern
- the same mirrors and chair placement
- a calm, real working atmosphere

Do not show:
- a different salon layout
- a studio look
- a promo-style beauty set

### `exact_salon_closeup`

Use when:
- the topic is better shown through a detail
- the room should stay recognizable, but the subject is tighter

Show:
- a working corner
- a shelf with products
- tools on a table
- a mirror detail
- a close process moment inside the same room

Do not show:
- a new interior
- a broad generic beauty set
- a fully posed portrait

### `neutral_nonhuman_object`

Use when:
- the topic is easier to show as a salon object scene
- the composition does not need the room itself as the main anchor

Show:
- care products
- tools
- towels
- combs, brushes, bottles, diffusers
- a calm neutral object arrangement

Do not show:
- a hero hairstyle
- a face-driven composition
- a fashion editorial scene

## Scenario Library

### 1. Care Products on a Work Surface

Best for:
- routine care
- product choice
- color protection
- gentle cleansing

Show:
- 2 to 4 products
- a simple work surface
- a real salon background or a neutral object scene

Avoid:
- ad-like product staging
- luxury showroom styling
- finished hairstyle as the main subject

### 2. Tools and Working Corner

Best for:
- heat protection
- drying
- daily habits
- styling mistakes

Show:
- dryer
- brush
- comb
- diffuser
- clips
- mirror or table detail

Avoid:
- banner compositions
- tool overload
- glossy retail display energy

### 3. Master Hands and Process Detail

Best for:
- how to apply a product
- how to distribute heat protection
- how to work with length and ends

Show:
- hands of the master
- a neutral process fragment
- the hair only as a secondary element

Avoid:
- client portrait
- posed beauty shot
- final hairstyle as the center of the image

### 4. Home Routine Without a Hero Client

Best for:
- post-visit care
- daily maintenance
- simple habits

Show:
- towel
- bottle
- comb
- mirror
- calm domestic beauty mood with salon logic

Avoid:
- fashion scene
- selfie framing
- perfect salon promo image

### 5. Error Or Warning Visual

Best for:
- overloading products
- bad drying
- bad habits
- post-salon mistakes

Show:
- a clear object-level contrast
- a calm realistic salon environment
- a slightly tighter crop if needed

Avoid:
- aggressive judgment
- caricature
- ugly chaos

## Selection Guidance

- If the topic is about steps, mistakes, or rules, prefer `exact_salon_closeup` or `neutral_nonhuman_object`.
- If the topic is about aftercare or routine, prefer `exact_salon_room` or `exact_salon_closeup`.
- If the topic is mostly about products, prefer `neutral_nonhuman_object`.
- When in doubt, choose the most realistic and least dramatic option.
