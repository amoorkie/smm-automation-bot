# Bot Service Bootstrap

## 1. Required services

- Telegram bot token
- OpenRouter API key
- Supabase project
- Vercel project
- внешний scheduler, если нужны вызовы cron endpoints вне ручного запуска

## 2. Supabase setup

1. Открой проект в Supabase.
2. Перейди в `SQL Editor`.
3. Создай новый query.
4. Вставь содержимое [schema.sql](/A:/ANITA-BOT/supabase/schema.sql).
5. Нажми `Run`.

После этого должны существовать таблицы:

- `expert_topics`
- `story_topics`
- `creative_ideas`
- `slider_topics`
- `content_queue`
- `prompt_templates`
- `publish_log`
- `bot_logs`
- `tg_sessions`
- `work_collections`
- `callback_tokens`
- `idempotency_keys`
- `publish_locks`
- `job_runtime_cache`

## 3. Prompt templates

Бот умеет стартовать без заполненной `prompt_templates`, потому что в коде есть embedded defaults.
Рекомендуемый current seed покрывает такие ключи:

- `help_message`
- `contact_block`
- `work_album_consistency_extraction`
- `work_image_enhancement_master`
- `work_image_enhancement_short`
- `work_image_enhancement_negative`
- `work_image_reframe_master`
- `work_collage_generation`
- `work_caption_generation`
- `topic_post_generation`
- `topic_image_generation`
- `story_manifest_generation`
- `story_visual_generation`
- `slider_manifest_generation`
- `slider_visual_generation`

Reference seed лежит в [prompt_config_seed_sample.csv](/A:/ANITA-BOT/smm_salon_docs/samples/prompt_config_seed_sample.csv).

## 4. Local env

Используй [`.env`](/A:/ANITA-BOT/.env) или [`.env.example`](/A:/ANITA-BOT/smm_salon_docs/config/.env.example).

Обязательные значения:

- `TG_BOT_TOKEN`
- `OPENROUTER_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `IMAGE_MODEL_ID`
- `TEXT_MODEL_ID`

Опциональные:

- `APP_TIMEZONE`
- `OWNER_CHAT_ID`
- `BOT_DISABLED`
- `INTERNAL_WORKER_DISPATCH_ENABLED`
- `TOPIC_SOURCE_STATUS_MUTATIONS_ENABLED`
- `WEBHOOK_BASE_URL`
- `VK_ACCESS_TOKEN`
- `VK_COMMUNITY_ACCESS_TOKEN`
- `VK_GROUP_ID`
- `VK_PUBLISH_ENABLED`
- `VK_CLIENT_ID`
- `VK_CLIENT_SECRET`
- `VK_OAUTH_REDIRECT_URI`
- `VK_OAUTH_SCOPE`
- `PORT`

Примечания:

- `APP_TIMEZONE` по умолчанию: `Europe/Moscow`
- `PORT` по умолчанию: `3000`
- на Vercel `WEBHOOK_BASE_URL` можно не задавать вручную, если доступен `VERCEL_URL`
- `INTERNAL_WORKER_DISPATCH_ENABLED=true` включает async self-dispatch для `POST /api/worker/runtime-action` и `POST /api/worker/collection-finalize`
- `TOPIC_SOURCE_STATUS_MUTATIONS_ENABLED=true` разрешает менять source-row статусы вне QA-safe режима
- `x-anita-worker-token` вычисляется из `TG_BOT_TOKEN`; отдельный worker secret сейчас не настраивается
- contact block задается через `prompt_templates.contact_block`, а не через env

## 5. Vercel env

В Vercel Project Settings -> Environment Variables добавь:

- `TG_BOT_TOKEN`
- `OPENROUTER_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `IMAGE_MODEL_ID`
- `TEXT_MODEL_ID`

При необходимости:

- `APP_TIMEZONE`
- `OWNER_CHAT_ID`
- `BOT_DISABLED`
- `INTERNAL_WORKER_DISPATCH_ENABLED`
- `TOPIC_SOURCE_STATUS_MUTATIONS_ENABLED`
- `WEBHOOK_BASE_URL`

## 6. Deploy

После настройки env:

1. Задеплой сервис на Vercel.
2. Проверь `GET /api/readyz`.
3. Проверь `GET /api/healthz`.
4. Выставь Telegram webhook на:
   - `/api/telegram/webhook`

## 7. HTTP endpoints

### Public

- `GET /api/healthz`
- `GET /api/readyz`
- `GET /api/vk/oauth/start`
- `GET /api/vk/oauth/callback`
- `POST /api/telegram/webhook`

### Internal/worker

- `GET /api/cron/finalize`
- `GET /api/cron/cleanup`
- `POST /api/worker/telegram-update`
- `POST /api/worker/runtime-action`
- `POST /api/worker/collection-finalize`

Worker endpoints требуют `x-anita-worker-token`.

VK OAuth endpoints публичные и нужны только для выпуска свежего user token через задеплоенный сервер:

- открыть `/api/vk/oauth/start`
- подтвердить доступ в VK
- скопировать возвращенный токен в `VK_ACCESS_TOKEN`
- сделать production redeploy

## 8. Scheduler notes

Текущий runtime не использует `/api/cron/deliver`.
Если нужен автоматический finalize/cleanup вне ручного запуска, внешний scheduler может дергать:

- `/api/cron/finalize`
- `/api/cron/cleanup`

## 9. Smoke test

Проверь:

1. `/help`
2. `/start`
3. `/work` -> выбор `обычное` или `студийное` -> 1 фото
4. `/work` -> выбор `обычное` или `студийное` -> 2-3 фото одним альбомом
5. для `normal` проверить ветки `background keep|blur` и `cleanup`
6. для `studio` проверить, что повторный экран выбора фона не появляется и generation идет сразу в neutral pipeline
7. `/topic`
8. `/stories`
9. `/slider`
10. revision actions:
   - `version_prev`
   - `version_next`
   - `regenerate_images`
   - `regenerate_text`
   - `regenerate_all`
   - `cancel`
11. `publish_confirm` для topic-like preview

## 10. Logs

Пользовательских `/logs` команд больше нет.

Операционные логи:

- primary sink:
  - structured stdout/stderr logs на Vercel
- secondary sink:
  - `bot_logs` в Supabase

Reference columns лежат в [bot_logs_header.csv](/A:/ANITA-BOT/smm_salon_docs/samples/bot_logs_header.csv).
