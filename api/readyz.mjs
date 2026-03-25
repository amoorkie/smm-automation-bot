import getVercelContext from '../src/vercel-context.mjs';

export default async function handler(_request, response) {
  if (String(process.env.BOT_DISABLED ?? '').trim().toLowerCase() === 'true') {
    response.status(503).json({ ok: false, error: 'bot_disabled' });
    return;
  }
  try {
    const { env } = await getVercelContext();
    response.status(200).json({ ok: true, timezone: env.appTimezone });
  } catch (error) {
    response.status(500).json({ ok: false, error: error.message });
  }
}
