# SMM Automation Bot System Spec

## 1. Scope

Текущий бот поддерживает пять продуктовых сценариев:

- `/work`:
  - принять 1-3 фото одной работы мастера;
  - подготовить preview;
  - дать действия для ревизий и публикации черновика.
- `/topic`:
  - выбрать тему экспертного поста из `expert_topics`;
  - собрать single-image preview и текст.
- `/stories`:
  - выбрать тему сториз из `story_topics`;
  - собрать single-slide story preview.
- `/slider`:
  - выбрать тему карусели из `slider_topics`;
  - собрать multi-slide preview из 3-5 слайдов.
- `/start`:
  - показать стартовое меню;
  - дать список доступных команд.

В этот этап не входят:

- контент-план;
- внешняя автопубликация вне Telegram;
- user-facing scheduling UX;
- `/logs` и `/logs raw` как продуктовые команды.

## 2. Runtime Architecture

- Hosting: Vercel
- Transport: Telegram webhook
- Local app server: Fastify
- Bot runtime: grammy
- Runtime storage: Supabase
- Image/text generation: OpenRouter
- Logs:
  - primary operational sink: structured JSON lines в stdout/stderr;
  - secondary durable sink: `bot_logs` в Supabase.

Google Sheets, Google Drive и SQLite больше не являются active runtime path.

## 3. Commands

Поддерживаются команды:

- `/help`
- `/start`
- `/work`
- `/topic`
- `/stories`
- `/slider`

Команды `/logs` и `/logs raw` удалены из продукта и считаются unknown command.

## 4. Source Tables

Текущие business source tables:

- `expert_topics`
- `story_topics`
- `slider_topics`

Таблица `creative_ideas` сохранена в schema и импортах ради backward compatibility, но user-facing `/creative` больше не входит в активный продуктовый surface.

Каждая строка темы или идеи имеет типовой контракт:

- `topic_id`
- `title`
- `brief`
- `tags`
- `priority`
- `status`
- `reserved_by`
- `reserved_at`
- `reservation_expires_at`
- `last_job_id`
- `last_published_at`
- `notes`

## 5. `/work` Flow

### 5.1 Session and collection rules

- `/work` открывает session window на 10 минут.
- Первое действие после `/work`:
  - `work_photo_type_normal`
  - `work_photo_type_studio`
  - `cancel`
- Runtime keeps a compatibility fallback: if the operator uploads photos before pressing a type button, the flow is treated as `work_photo_type_normal`.
- Фото принимаются только после `/work`; иначе бот отвечает `Сначала отправь /work, потом фото.`
- Одна logical collection содержит от 1 до 3 фото.
- Базовый debounce финализации коллекции: 3 секунды после последнего фото.
- Для первого фото альбома и для неполного альбома применяются короткие grace windows поверх базового debounce.
- Одинарное фото без `media_group_id` тоже финализируется через debounce window.
- После стабилизации коллекции бот не всегда начинает generation одинаково:
  - сначала показывает выбор subject type;
  - для multi-photo сценария затем показывает `render_mode_collage` / `render_mode_separate`;
  - для brows отдельно спрашивает `до / после` или `только после`;
  - для `studio` generation уходит сразу в neutral pipeline без повторного выбора фона;
  - для `normal` на фоне остаются только `background_mode_keep` и `background_mode_blur`, после чего может идти cleanup step.

### 5.2 Current UX

- `/work` сначала открывает выбор типа фото, а уже затем окно загрузки фото.
- Single-photo hair flow:
  - `photo type`
  - upload
  - `subject`
  - для `normal`: `background keep|blur` -> `cleanup`
  - для `studio`: immediate neutral generation
- Single-photo brow flow:
  - `photo type`
  - upload
  - `subject=brows`
  - `brow output`
  - для `normal`: `background keep|blur` -> `cleanup`
  - для `studio`: immediate neutral brow generation
- Multi-photo flow:
  - `photo type`
  - upload
  - `subject`
  - `render mode`
  - далее либо `brow output`, либо background/cleanup, либо immediate studio generation
- После выбора режима бот отправляет progress messages:
  - начало обработки;
  - подготовка изображений;
  - подготовка текста;
  - сборка результата.
- Для `collage` preview обычно отправляется как single image.
- Для `separate` preview отправляется album/multi-photo group.

### 5.3 Image processing

Обработка work photo — это image edit, а не image generation.

Неподвижные ограничения:

- сохраняются человек и идентичность;
- сохраняются лицо, прическа, длина волос, цвет волос, аксессуары и одежда;
- итог работы мастера не меняется;
- допускается улучшение качества, света, clarity и framing;
- запрещены face swap, новая прическа, beauty filter и агрессивная ретушь.

### 5.4 Work caption contract

- всегда от первого лица одного мастера;
- без `мы`, `наш салон`, `наши мастера`, `команда`;
- если услуга видна уверенно, она может быть названа;
- если уверенности нет, услуга не выдумывается;
- contact block обязателен;
- contact block задается через `prompt_templates.contact_block`, а не через env.

### 5.5 Work revision actions

После генерации поддерживаются:

- `version_prev`
- `version_next`
- `regenerate_images`
- `regenerate_text`
- `regenerate_all`
- `cancel`

`publish_confirm` для `/work` не используется.

## 6. Topic-Like Flow

### 6.1 Common contract

Режимы `/topic`, `/stories`, `/slider` работают одинаково по верхнему уровню:

- бот не берет следующую тему автоматически;
- сначала открывается picker со строками в статусе `ready`;
- picker работает страницами по 10 элементов;
- picker использует callback actions:
  - `pick_source_*`
  - `picker_prev_*`
  - `picker_next_*`
  - `picker_cancel_*`
- при выборе строки бот резервирует ее на 120 минут;
- при истечении резерва неиспользованные строки возвращаются в `ready`.

### 6.2 `/topic`

- source table: `expert_topics`
- preview type: single image + text
- text prompt: `topic_post_generation`
- image prompt: `topic_image_generation`
- image generation использует salon reference images как anchors

### 6.3 `/stories`

- source table: `story_topics`
- preview type: single vertical story slide
- prompt pair:
  - `story_manifest_generation`
  - `story_visual_generation`

### 6.4 `/slider`

- source table: `slider_topics`
- preview type: 3-5 vertical slides
- prompt pair:
  - `slider_manifest_generation`
  - `slider_visual_generation`
- если model output sparse, runtime все равно собирает минимум 3 слайда.

## 7. Draft and callback actions

Текущий callback surface:

- picker actions:
  - `pick_source_*`
  - `picker_prev_*`
  - `picker_next_*`
  - `picker_cancel_*`
- work bootstrap actions:
  - `work_photo_type_normal`
  - `work_photo_type_studio`
  - `cancel`
- work runtime actions:
  - `work_subject_hair`
  - `work_subject_brows`
  - `render_mode_collage`
  - `render_mode_separate`
  - `brow_output_before_after`
  - `brow_output_after_only`
  - `background_mode_keep`
  - `background_mode_blur`
  - `cleanup_on`
  - `cleanup_off`
  - `cancel`
- revision actions:
  - `version_prev`
  - `version_next`
  - `regenerate_images`
  - `regenerate_text`
  - `regenerate_all`
  - `cancel`
- publish action:
  - `publish_confirm`

Текущий продукт не поддерживает user-facing `schedule` action.
`publish_now` больше не является актуальным action name.

## 8. Logging Contract

Structured log entry использует поля:

- `ts`
- `level`
- `event`
- `workflow`
- `execution_id`
- `chat_id`
- `user_id`
- `job_id`
- `queue_id`
- `source_type`
- `stage`
- `collection_id`
- `node`
- `status`
- `duration_ms`
- `message`
- `payload_json`

Безопасность логов:

- без токенов;
- без auth headers;
- без длинных base64/blob payloads;
- payload режется до безопасного размера.

## 9. HTTP Surface

### 9.1 Local Fastify routes

- `GET /healthz`
- `GET /readyz`
- `GET /cron/finalize`
- `GET /cron/cleanup`
- `POST /telegram/webhook`
- `POST /worker/telegram-update`
- `POST /worker/runtime-action`
- `POST /worker/collection-finalize`

### 9.2 Vercel handlers

- `GET /api/healthz`
- `GET /api/readyz`
- `GET /api/cron/finalize`
- `GET /api/cron/cleanup`
- `POST /api/telegram/webhook`
- `POST /api/worker/telegram-update`
- `POST /api/worker/runtime-action`
- `POST /api/worker/collection-finalize`

### 9.3 Worker auth

Worker endpoints защищены заголовком:

- `x-anita-worker-token`

Ожидаемое значение вычисляется как `sha256(TG_BOT_TOKEN)`.

## 10. Env Contract

Обязательные переменные:

- `TG_BOT_TOKEN`
- `OPENROUTER_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `IMAGE_MODEL_ID`
- `TEXT_MODEL_ID`

Необязательные или derived:

- `APP_TIMEZONE`
  - default: `Europe/Moscow`
- `OWNER_CHAT_ID`
- `BOT_DISABLED`
- `WEBHOOK_BASE_URL`
  - если пусто, runtime пытается вывести base URL из `VERCEL_URL`
- `PORT`
  - local default: `3000`

В текущем контракте нет `MASTER_CONTACT_PHONE`.

## 11. Truth Sources

При конфликте источников использовать приоритет:

1. код и тесты;
2. этот system spec;
3. bootstrap и env example;
4. legacy/reference artifacts.
