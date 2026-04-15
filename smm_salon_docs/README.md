# SMM Automation Bot Docs

Этот каталог хранит публичную техническую документацию по продукту и текущему runtime-контракту `SMM Automation Bot`.

## Зачем нужен этот каталог

- здесь зафиксированы продуктовые сценарии, env-контракт, storage и маршруты;
- здесь лежит bootstrap для запуска и деплоя;
- изменения runtime surface должны обновляться здесь в том же change set, что и код.

## Что считать источником истины

- Основной runtime contract:
  - `01_system_spec.md`
  - `02_bot_service_bootstrap.md`
- `03_roadmap_and_doc_governance.md`
- `04_folder_queue_automation.md`
- `config/.env.example`
- `../supabase/schema.sql`
- Реализация:
  - `../src/`
  - `../api/`
  - `../tests/`

## Статус подпапок

- `config/`:
  - актуальный env contract для runtime.
- `prompts/`:
  - актуальные prompt references и registry для продуктовых режимов.
- `samples/`:
  - reference-only примеры seed-файлов и заголовков.
- `schemas/`:
  - mixed; часть файлов является reference schema, а не authoritative runtime validation.
- `sheets_templates/`:
  - import/reference templates; реальный колонночный контракт задаётся кодом и `supabase/schema.sql`.

## Рекомендуемый порядок чтения

1. `01_system_spec.md`
2. `02_bot_service_bootstrap.md`
3. `03_roadmap_and_doc_governance.md`
4. `04_folder_queue_automation.md`
5. `config/.env.example`
6. `../supabase/schema.sql`

## Краткое summary по runtime

- Hosting: Vercel
- User interface: Telegram
- Runtime storage: Supabase
- AI provider: OpenRouter
- Local server: Fastify
- Bot framework: grammy
- Logs:
  - primary sink: structured JSON lines in stdout/stderr
  - secondary durable sink: `bot_logs` in Supabase

## Правило обновления

Если меняется что-то из списка ниже, документация в этом каталоге должна обновляться в том же change set:

- commands;
- `/work` UX;
- topic-like modes;
- callback actions;
- env contract;
- Supabase tables / columns;
- Fastify or Vercel routes;
- logging contract.
