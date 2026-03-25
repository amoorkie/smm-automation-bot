create table if not exists public.expert_topics (
  id bigint generated always as identity primary key,
  topic_id text not null unique,
  title text not null default '',
  brief text not null default '',
  tags text not null default '',
  priority text not null default '',
  status text not null default 'ready',
  reserved_by text not null default '',
  reserved_at text not null default '',
  reservation_expires_at text not null default '',
  last_job_id text not null default '',
  last_published_at text not null default '',
  notes text not null default ''
);

create table if not exists public.story_topics (
  id bigint generated always as identity primary key,
  topic_id text not null unique,
  title text not null default '',
  brief text not null default '',
  tags text not null default '',
  priority text not null default '',
  status text not null default 'ready',
  reserved_by text not null default '',
  reserved_at text not null default '',
  reservation_expires_at text not null default '',
  last_job_id text not null default '',
  last_published_at text not null default '',
  notes text not null default ''
);

create table if not exists public.creative_ideas (
  id bigint generated always as identity primary key,
  topic_id text not null unique,
  title text not null default '',
  brief text not null default '',
  tags text not null default '',
  priority text not null default '',
  status text not null default 'ready',
  reserved_by text not null default '',
  reserved_at text not null default '',
  reservation_expires_at text not null default '',
  last_job_id text not null default '',
  last_published_at text not null default '',
  notes text not null default ''
);

create table if not exists public.slider_topics (
  id bigint generated always as identity primary key,
  topic_id text not null unique,
  title text not null default '',
  brief text not null default '',
  tags text not null default '',
  priority text not null default '',
  status text not null default 'ready',
  reserved_by text not null default '',
  reserved_at text not null default '',
  reservation_expires_at text not null default '',
  last_job_id text not null default '',
  last_published_at text not null default '',
  notes text not null default ''
);

create table if not exists public.content_queue (
  id bigint generated always as identity primary key,
  queue_id text not null unique,
  job_id text not null default '',
  job_type text not null default '',
  revision text not null default '1',
  status text not null default 'draft',
  scheduled_at text not null default '',
  publish_channel text not null default 'telegram',
  caption_text text not null default '',
  collage_drive_file_id text not null default '',
  asset_drive_file_ids text not null default '',
  topic_id text not null default '',
  vk_post_id text not null default '',
  publish_attempt_count text not null default '0',
  last_publish_attempt_at text not null default '',
  last_error_code text not null default '',
  last_error_message text not null default '',
  created_at text not null default '',
  updated_at text not null default ''
);

create table if not exists public.prompt_templates (
  id bigint generated always as identity primary key,
  prompt_key text not null unique,
  version text not null default '1',
  status text not null default 'active',
  model_id_override text not null default '',
  temperature text not null default '',
  content text not null default '',
  notes text not null default '',
  updated_at text not null default ''
);

create table if not exists public.publish_log (
  id bigint generated always as identity primary key,
  publish_id text not null unique,
  queue_id text not null default '',
  job_id text not null default '',
  channel text not null default 'telegram',
  status text not null default '',
  attempt_no text not null default '1',
  vk_owner_id text not null default '',
  vk_post_id text not null default '',
  vk_attachment_ids text not null default '',
  provider_error_code text not null default '',
  provider_error_message text not null default '',
  raw_response_ref text not null default '',
  created_at text not null default ''
);

create table if not exists public.bot_logs (
  id bigint generated always as identity primary key,
  ts text not null default '',
  level text not null default 'INFO',
  event text not null default '',
  workflow text not null default '',
  execution_id text not null default '',
  chat_id text not null default '',
  user_id text not null default '',
  job_id text not null default '',
  queue_id text not null default '',
  source_type text not null default '',
  stage text not null default '',
  collection_id text not null default '',
  node text not null default '',
  status text not null default '',
  duration_ms text not null default '',
  message text not null default '',
  payload_json text not null default ''
);

create table if not exists public.tg_sessions (
  id bigint generated always as identity primary key,
  session_id text not null unique,
  chat_id text not null default '',
  user_id text not null default '',
  mode text not null default '',
  state text not null default '',
  active_job_id text not null default '',
  pending_payload_json text not null default '',
  expires_at text not null default '',
  updated_at text not null default ''
);

create table if not exists public.work_collections (
  id bigint generated always as identity primary key,
  collection_id text not null unique,
  collection_key text not null default '',
  chat_id text not null default '',
  user_id text not null default '',
  first_message_id text not null default '',
  media_group_id text not null default '',
  status text not null default 'collecting',
  asset_refs_json text not null default '[]',
  count text not null default '0',
  deadline_at text not null default '',
  last_message_at text not null default '',
  closed_by_job_id text not null default '',
  created_at text not null default '',
  updated_at text not null default ''
);

create table if not exists public.callback_tokens (
  id bigint generated always as identity primary key,
  token text not null unique,
  token_set_id text not null default '',
  job_id text not null default '',
  revision text not null default '1',
  action text not null default '',
  used text not null default '0',
  superseded text not null default '0',
  expires_at text not null default '',
  issued_at text not null default '',
  payload_json text not null default '',
  created_at text not null default '',
  updated_at text not null default ''
);

create table if not exists public.idempotency_keys (
  id bigint generated always as identity primary key,
  idem_key text not null unique,
  scope text not null default '',
  payload_hash text not null default '',
  created_at text not null default '',
  expires_at text not null default ''
);

create table if not exists public.publish_locks (
  id bigint generated always as identity primary key,
  lock_key text not null unique,
  job_id text not null default '',
  queue_id text not null default '',
  created_at text not null default '',
  expires_at text not null default ''
);

create table if not exists public.job_runtime_cache (
  id bigint generated always as identity primary key,
  job_id text not null unique,
  job_type text not null default '',
  chat_id text not null default '',
  user_id text not null default '',
  topic_id text not null default '',
  collection_id text not null default '',
  active_revision text not null default '1',
  runtime_status text not null default '',
  collage_message_id text not null default '',
  assets_message_ids_json text not null default '[]',
  text_message_id text not null default '',
  active_callback_set_id text not null default '',
  schedule_input_pending text not null default '0',
  lock_flags_json text not null default '{}',
  preview_payload_json text not null default '',
  draft_payload_json text not null default '',
  updated_at text not null default ''
);

create index if not exists expert_topics_status_idx on public.expert_topics (status);
create index if not exists story_topics_status_idx on public.story_topics (status);
create index if not exists creative_ideas_status_idx on public.creative_ideas (status);
create index if not exists slider_topics_status_idx on public.slider_topics (status);
create index if not exists content_queue_status_idx on public.content_queue (status);
create index if not exists work_collections_status_idx on public.work_collections (status);
create index if not exists callback_tokens_token_set_idx on public.callback_tokens (token_set_id);
