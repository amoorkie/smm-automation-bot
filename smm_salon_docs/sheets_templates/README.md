# Sheets Templates

Этот каталог содержит CSV reference/import templates.

## Current interpretation

- `expert_topics.csv`
- `story_topics.csv`
- `creative_ideas.csv`
- `slider_topics.csv`
- `prompt_config.csv`
- `content_queue.csv`
- `publish_log.csv`

Эти файлы считаются current import/reference templates для Supabase CSV import или ручного seed review.

## Important rule

Authoritative column contract задается не этими CSV, а:

- `../../supabase/schema.sql`
- `../../src/config/defaults.mjs`

Если CSV header расходится с кодом или `schema.sql`, нужно править CSV.

## Legacy note

Некоторые transport column names сохранены ради compatibility semantics, даже если их имя исторически связано со старым runtime:

- `collage_drive_file_id`
- `asset_drive_file_ids`

Их нельзя интерпретировать как подтверждение active Google Drive path.
