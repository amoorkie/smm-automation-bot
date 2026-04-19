function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

function pageShell({ title, body }) {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: Georgia, "Times New Roman", serif; }
    body { margin: 0; padding: 32px; background: #f6f1e8; color: #201b16; }
    main { max-width: 760px; margin: 0 auto; background: #fffaf2; border: 1px solid #ddcfbd; border-radius: 18px; padding: 28px; box-shadow: 0 18px 48px rgba(54, 43, 31, .14); }
    h1 { margin: 0 0 14px; font-size: 28px; line-height: 1.15; }
    p { line-height: 1.55; }
    textarea { box-sizing: border-box; width: 100%; min-height: 150px; margin: 12px 0; padding: 14px; border: 1px solid #c8b79f; border-radius: 12px; font-family: Consolas, monospace; font-size: 13px; resize: vertical; }
    code { background: #efe3d2; border-radius: 6px; padding: 2px 6px; }
    .meta { color: #6a5b49; font-size: 14px; }
    .error { color: #9b1c1c; }
  </style>
</head>
<body>
  <main>${body}</main>
</body>
</html>`;
}

export function renderVkOAuthSuccessPage({ accessToken, expiresIn, userId, obtainedAt }) {
  const expiresText = Number(expiresIn) > 0 ? `${Number(expiresIn)} секунд` : 'не указан';
  return pageShell({
    title: 'VK OAuth token',
    body: `
      <h1>VK-токен получен через сервер</h1>
      <p>Этот токен был выпущен через callback бота. Скопируй его в переменную <code>VK_ACCESS_TOKEN</code> в Vercel и сделай redeploy.</p>
      <textarea readonly>${escapeHtml(accessToken)}</textarea>
      <p class="meta">user_id: <code>${escapeHtml(userId || 'unknown')}</code></p>
      <p class="meta">expires_in: <code>${escapeHtml(expiresText)}</code></p>
      <p class="meta">obtained_at: <code>${escapeHtml(obtainedAt)}</code></p>
      <p class="meta">Не публикуй этот токен в GitHub и не вставляй в README.</p>
    `,
  });
}

export function renderVkOAuthErrorPage(error) {
  const message = error?.message || 'VK OAuth failed';
  const code = error?.code || 'vk_oauth_error';
  return pageShell({
    title: 'VK OAuth error',
    body: `
      <h1 class="error">Не получилось получить VK-токен</h1>
      <p>Ошибка: <code>${escapeHtml(code)}</code></p>
      <p>${escapeHtml(message)}</p>
    `,
  });
}
