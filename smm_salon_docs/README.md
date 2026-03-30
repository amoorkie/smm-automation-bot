# SMM Salon Bot Docs

Этот каталог является каноническим source of truth для текущего runtime и продуктового контракта `SMM Automation Bot`.

## Роль каталога

- здесь лежит актуальный runtime/product contract;
- здесь фиксируются env, storage, routes, flows и bootstrap;
- любые изменения commands, env, tables, callbacks, routes и logging должны обновляться здесь в том же change set, что и код.

## Что считать истиной

- Канонический runtime contract:
  - `01_system_spec.md`
  - `02_bot_service_bootstrap.md`
  - `03_roadmap_and_doc_governance.md`
  - `config/.env.example`
  - `../supabase/schema.sql`
- Каноническая реализация:
  - `../src/`
  - `../api/`
  - `../tests/`
- Operational memory:
  - `../memory_bank/`
  - этот каталог тоже должен быть актуальным, но он не должен конкурировать с этим README и system spec по runtime-утверждениям.

## Статус подпапок

- `config/`:
  - current
  - входной env contract для runtime
- `prompts/`:
  - current
  - prompt registry и prompt references для topic-like режимов
- `samples/`:
  - current, но reference-only
  - sample seeds и headers для import/bootstrap
- `schemas/`:
  - mixed
  - часть файлов является reference schema, а не authoritative runtime validation; см. `schemas/README.md`
- `sheets_templates/`:
  - current as import/reference templates
  - authoritative column contract все равно задается кодом и `supabase/schema.sql`; см. `sheets_templates/README.md`

## Рекомендуемый порядок чтения

1. `01_system_spec.md`
2. `02_bot_service_bootstrap.md`
3. `03_roadmap_and_doc_governance.md`
4. `config/.env.example`
5. `../supabase/schema.sql`
6. `../memory_bank/README.md`

## Active runtime summary

- Hosting: Vercel
- User interface: Telegram
- Runtime storage: Supabase
- AI provider: OpenRouter
- Local server: Fastify
- Bot framework: grammy
- Operational logs:
  - primary sink: structured JSON lines in stdout/stderr
  - secondary durable sink: `bot_logs` table in Supabase

## Update rule

Если меняется что-то из списка ниже, этот каталог обязан обновиться в том же PR/change set:

- commands
- `/work` UX
- topic-like modes
- callback actions
- env contract
- Supabase tables / columns
- Fastify or Vercel routes
- logging contract
