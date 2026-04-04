# Roadmap and Documentation Governance

## 1. Governance

### 1.1 Document roles

- `smm_salon_docs/`:
  - canonical runtime and product contract
- `src/`, `api/`, `tests/`, `supabase/schema.sql`:
  - implementation truth
- `schemas/`, `samples/`, `sheets_templates/`:
  - reference artifacts
  - могут быть `current` или `legacy`, это должно быть явно помечено README-файлами

### 1.2 Update policy

При изменении любого из контрактов ниже документация должна обновляться в том же change set:

- commands
- user flows
- callback actions
- env contract
- Supabase tables and columns
- public routes
- worker routes
- logging contract
- prompt key surface

### 1.3 Conflict policy

Если документы расходятся:

1. исправить кодовую или тестовую правду, если проблема в реализации;
2. затем синхронно обновить `smm_salon_docs/`;
3. historical записи не переписывать, а supersede-ить новой записью.

### 1.4 Legacy policy

- legacy-артефакты не удаляются автоматически;
- они должны быть явно помечены как `legacy`, `historical reference` или `mixed`;
- legacy-файл не должен выглядеть как active runtime contract.

## 2. Current documentation gaps closed by this pass

- commands surface синхронизирован с кодом;
- topic-like modes описаны как current product surface;
- bootstrap приведен к реальным Supabase tables и routes;
- docs-contract tests покрывают минимальные инварианты синхронизации.

## 3. Near-term roadmap

### 3.1 Product/runtime

- Добавить реальный user-facing scheduling UX, если он снова станет продуктовой функцией.
- Уточнить publish flow:
  - что именно означает `publish_confirm`;
  - какие side effects допустимы в phase 1;
  - нужен ли отдельный published audit trail сверх текущего `publish_log`.
- Решить, нужен ли richer worker orchestration path для тяжелых runtime actions.

### 3.2 Observability

- Уточнить retention и operational usage для `bot_logs`.
- Добавить отдельные smoke checks для worker endpoints.
- Решить, нужен ли `readyz` richer contract кроме `ok/timezone`.

### 3.3 Content system

- Зафиксировать, нужен ли explicit registry всех prompt keys в коде.
- Решить, должна ли `prompt_templates` считаться strict contract или permissive override surface.
- Привести reference schemas либо к current contract, либо окончательно пометить как historical-only.

### 3.4 Tooling

- Расширить docs-contract tests при появлении новых commands, env vars или tables.
- При необходимости добавить lightweight script/check, который перечисляет expected documentation touchpoints для runtime changes.

## 4. Acceptance criteria for future docs work

- `npm test` green;
- core docs не расходятся с runtime commands, tables, routes и callback actions;
- legacy artifacts имеют явную маркировку;
- новый инженер может начать с `README -> system spec -> bootstrap -> roadmap` без скрытых противоречий.
