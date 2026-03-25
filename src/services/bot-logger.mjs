import {
  BOT_LOG_COLUMNS,
  buildBotLogEntry,
} from '../domain/index.mjs';
import { TABLE_NAMES } from '../config/defaults.mjs';

function redactString(value) {
  return String(value ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gu, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9_-]+/gu, '[redacted-key]')
    .replace(/bot\d+:[A-Za-z0-9_-]+/gu, '[redacted-bot-token]')
    .replace(/data:[^,]+,[A-Za-z0-9+/=]{40,}/gu, 'data:[redacted]');
}

function sanitizePayload(value) {
  if (value == null || value === '') {
    return '';
  }
  const text = redactString(typeof value === 'string' ? value : JSON.stringify(value));
  return text.length > 1000 ? `${text.slice(0, 997)}...` : text;
}

export class BotLogger {
  constructor({ workflow = 'anita_bot_service', store = null, tableName = TABLE_NAMES.botLogs } = {}) {
    this.workflow = workflow;
    this.store = store;
    this.tableName = tableName;
  }

  async log(entry) {
    const row = buildBotLogEntry({
      workflow: this.workflow,
      ...entry,
      payload: entry?.payload ?? null,
    });
    row.payload_json = sanitizePayload(row.payload_json);
    const sanitized = Object.fromEntries(
      BOT_LOG_COLUMNS.map((column) => [column, row[column] ?? '']),
    );
    const line = JSON.stringify(sanitized);
    if (String(sanitized.level).toUpperCase() === 'ERROR' || String(sanitized.status).toLowerCase() === 'failed') {
      console.error(line);
    } else {
      console.log(line);
    }
    if (this.store) {
      try {
        await this.store.appendRow(this.tableName, sanitized, BOT_LOG_COLUMNS);
      } catch (error) {
        console.error(JSON.stringify({
          ts: new Date().toISOString(),
          level: 'ERROR',
          event: 'bot_log_sink_failed',
          workflow: this.workflow,
          status: 'failed',
          message: error.message,
        }));
      }
    }
    return sanitized;
  }
}

export default BotLogger;
