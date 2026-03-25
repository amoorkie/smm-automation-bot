import { Bot } from 'grammy';

export function createTelegramBot(env) {
  return new Bot(env.tgBotToken);
}

export default createTelegramBot;
