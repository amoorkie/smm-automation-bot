import createTelegramBot from './bot/handlers.mjs';
import loadEnv from './config/env.mjs';
import { BUSINESS_SHEET_HEADERS, RUNTIME_SHEET_HEADERS } from './config/defaults.mjs';
import createRepositories from './runtime/repositories.mjs';
import BotLogger from './services/bot-logger.mjs';
import OpenRouterService from './services/openrouter.mjs';
import PromptConfigService from './services/prompt-config.mjs';
import SalonBotService from './services/bot-service.mjs';
import SupabaseStoreService from './services/supabase-store.mjs';
import createServer from './http/server.mjs';

export async function createRuntimeContext(sourceEnv = process.env) {
  const env = loadEnv(sourceEnv);
  const bot = createTelegramBot(env);
  const store = new SupabaseStoreService({
    url: env.supabaseUrl,
    serviceRoleKey: env.supabaseServiceRoleKey,
  });

  await store.validateContract(RUNTIME_SHEET_HEADERS);
  await store.validateContract(BUSINESS_SHEET_HEADERS);

  const repos = createRepositories(store);
  const botLogger = new BotLogger({ store });
  const promptConfig = new PromptConfigService({ store });
  const openrouter = new OpenRouterService({
    apiKey: env.openRouterApiKey,
    textModelId: env.textModelId,
    imageModelId: env.imageModelId,
  });
  const service = new SalonBotService({
    env,
    bot,
    repos,
    store,
    openrouter,
    promptConfig,
    botLogger,
  });

  return {
    env,
    repos,
    bot,
    store,
    botLogger,
    promptConfig,
    openrouter,
    service,
  };
}

export async function createApp(sourceEnv = process.env) {
  const context = await createRuntimeContext(sourceEnv);
  const server = createServer(context);
  return {
    ...context,
    server,
    async start() {
      await server.start();
      return this;
    },
    async stop() {
      await server.stop();
    },
  };
}

export default createApp;
