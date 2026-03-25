# AI Photo Processing Prompt v2 — Hair / Brows / Beauty Portfolio

Нормализованная UTF-8 копия исходного файла из:
`C:\Users\amoor\Downloads\hair_master_ai_prompt_v2.md`

Этот документ используется как reference material для image prompt family:
- `work_image_enhancement_master`
- `work_image_reframe_master`
- `work_collage_generation`

Цель: получить чистые, дорогие, спокойные, профессиональные фотографии для публикации в портфолио и соцсетях, без изменения личности клиента и без дорисовки новой работы.

## Что должен делать ИИ

- улучшать текущую фотографию, а не генерировать нового человека
- исправлять свет, цвет, чёткость, композицию и наклон камеры
- делать акцент на работе мастера: стрижка, укладка, окрашивание, брови, причёска
- сохранять реальные черты лица клиента
- держать единый стиль обработки на всей серии фотографий

## Что ИИ делать не должен

- генерировать нового человека
- менять лицо, форму головы, глаза, нос, губы, челюсть, уши
- убирать или переносить родинки, шрамы, морщины, асимметрию, складки, поры
- менять форму стрижки или дорисовывать новую работу
- делать глянцевую бьюти-ретушь кожи
- превращать фото в fashion-art, heavy retouch или иллюстрацию

## Master Prompt

```text
IMAGE EDITING TASK ONLY.

Use the uploaded photograph as the source image.
This is NOT image generation.
Only improve the existing photo.

GOAL:
Transform the photo into a clean, professional beauty portfolio image while preserving the real person exactly as they are.
The main focus must be the beauty work: hairstyle, haircut, coloring, styling, eyebrows, or makeup result.

STRICT IDENTITY LOCK:
The person must remain EXACTLY the same.
Do NOT generate a new face or a new person.
Do NOT modify facial identity, facial structure, or facial geometry.

Preserve exactly:
- face shape
- head shape
- eyes
- eyelids
- nose shape
- lips
- jawline
- cheeks
- ears
- eyebrow shape
- skin texture
- pores
- wrinkles
- freckles
- moles
- scars
- beard stubble
- all asymmetry
- all facial marks in their exact original positions

Do NOT:
- beautify the face
- smooth skin artificially
- remove pores
- relocate facial marks
- delete moles or scars
- change age
- change expression
- change ethnicity
- change facial proportions
- reconstruct the face

If the face is visible, leave it untouched.
If the hairstyle is the main subject, improve only presentation quality, not the design itself.

IMAGE QUALITY TARGET:
- premium beauty portfolio look
- clean exposure
- neutral-to-premium white balance
- crisp but natural detail
- controlled contrast
- realistic hair texture
- elegant overall finish

COMPOSITION:
- keep the hairstyle or beauty result as the visual center
- straighten the frame if the camera is tilted
- reduce awkward dead space
- improve crop only if needed
- do not crop out important parts of the hairstyle or brows

HAIR / BROWS / BEAUTY RESULT:
- preserve the real work exactly
- do not redesign curls, lines, volume, color placement, fade pattern, or eyebrow architecture
- do not add new strands, ornaments, accessories, or fake density
- do not repaint the result into a different technique

BACKGROUND:
- keep the original environment realistic
- you may softly calm it down, simplify distractions, or slightly blur it
- do not replace the location with a new fake studio unless the original background is unusable
- never let the background compete with the hair or beauty result

SKIN:
- keep it real and natural
- no plastic skin
- no glamour smoothing
- no obvious retouching

FINAL LOOK:
Make the image feel premium, expensive, calm, and professional.
It should look like a high-quality portfolio photo of a real client after a real service.

Absolutely preserve identity and the actual work result.
```

## Practical additions for current bot behavior

- Для волос важнее подчёркивать форму, направление линий, блеск и чистоту силуэта, чем «салонную магию».
- Для портфолио допускается лёгкое приглушение фона, если оно не выглядит как новый сгенерированный интерьер.
- Если серия состоит из нескольких кадров одной работы, стиль обработки должен быть единым.
- Для коллажа модель должна показывать причёску как главный объект и избегать чёрных полос, жёстких кропов и провалов по композиции.
