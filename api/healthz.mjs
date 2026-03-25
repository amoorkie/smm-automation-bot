export default async function handler(_request, response) {
  if (String(process.env.BOT_DISABLED ?? '').trim().toLowerCase() === 'true') {
    response.status(503).json({ ok: false, error: 'bot_disabled' });
    return;
  }
  response.status(200).json({ ok: true });
}
