# SMM Automation Bot

Telegram bot for salon SMM automation.

The service helps a salon operator prepare preview-ready content inside Telegram:
- `/work` for before/after work posts from 1 to 3 photos
- `/topic` for expert post generation from a curated topic queue
- `/stories` for vertical story previews
- `/creative` for single-image promo concepts from curated ideas
- `/slider` for multi-slide carousel previews

## Stack

- Node.js ESM
- Fastify
- grammy
- Supabase
- Vercel
- OpenRouter
- sharp + satori/resvg for image composition

## Project Structure

- `src/` application runtime
- `api/` Vercel handlers
- `supabase/schema.sql` storage contract
- `tests/` runtime and contract tests
- `smm_salon_docs/` canonical product and runtime documentation

## Local Run

1. Copy env values from `smm_salon_docs/config/.env.example`.
2. Install dependencies:

```bash
npm install
```

3. Start the app:

```bash
npm run dev
```

## Validation

```bash
npm test
```

## Deployment

The service is designed for Vercel. Runtime bootstrap, routes, and env contract are documented in:

- `smm_salon_docs/01_system_spec.md`
- `smm_salon_docs/02_bot_service_bootstrap.md`

## Notes

- Source content tables are stored in Supabase.
- Contact block and prompt overrides are managed through `prompt_templates`.
- The bot is optimized around Telegram-first operator workflows rather than a separate admin UI.
