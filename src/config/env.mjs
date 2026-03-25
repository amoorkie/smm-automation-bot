import 'dotenv/config';

function required(name, value) {
  const normalized = typeof value === 'string' ? value.trim() : value;
  if (!normalized) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return normalized;
}

function parsePort(value, fallback = 3000) {
  if (!value) {
    return fallback;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT value: ${value}`);
  }
  return port;
}

function parseNullableChatId(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  return String(value).trim();
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

export function loadEnv(source = process.env) {
  const derivedWebhookBaseUrl = source.WEBHOOK_BASE_URL
    ?? (source.VERCEL_URL ? `https://${source.VERCEL_URL}` : null);

  return {
    nodeEnv: source.NODE_ENV ?? 'development',
    port: parsePort(source.PORT, 3000),
    appTimezone: typeof source.APP_TIMEZONE === 'string' && source.APP_TIMEZONE.trim()
      ? source.APP_TIMEZONE.trim()
      : 'Europe/Moscow',
    tgBotToken: required('TG_BOT_TOKEN', source.TG_BOT_TOKEN),
    openRouterApiKey: required('OPENROUTER_API_KEY', source.OPENROUTER_API_KEY),
    supabaseUrl: required('SUPABASE_URL', source.SUPABASE_URL),
    supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY', source.SUPABASE_SERVICE_ROLE_KEY),
    webhookBaseUrl: derivedWebhookBaseUrl,
    imageModelId: required('IMAGE_MODEL_ID', source.IMAGE_MODEL_ID),
    textModelId: required('TEXT_MODEL_ID', source.TEXT_MODEL_ID),
    ownerChatId: parseNullableChatId(source.OWNER_CHAT_ID),
    botDisabled: parseBoolean(source.BOT_DISABLED, false),
    topicSourceStatusMutationsEnabled: parseBoolean(source.TOPIC_SOURCE_STATUS_MUTATIONS_ENABLED, false),
  };
}

export default loadEnv;
