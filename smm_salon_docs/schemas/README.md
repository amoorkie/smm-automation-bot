# Schemas

Этот каталог содержит reference schemas.

## Status

- `prompt_config.schema.json`:
  - current reference
  - описывает current prompt row shape
- Остальные schema files:
  - mixed / historical reference
  - они полезны как design artifacts и handoff material, но не являются authoritative runtime validation

## Authoritative contract

Для текущего runtime authoritative sources:

- `../01_system_spec.md`
- `../02_bot_service_bootstrap.md`
- `../../supabase/schema.sql`
- `../../src/config/defaults.mjs`
- `../../src/workflow-kit.mjs`

Если schema file расходится с этими источниками, authoritative считаются runtime docs и код.
