const copy = {
  en: {
    heading: 'Allow GrantTap on this Mac',
    detail: 'GrantTap for Mac needs access to the local GrantTap service to show your tasks, send messages, handle approvals, and configure the relay.',
    scope: 'This approval applies only to this Mac app on this computer. It does not authorize another computer or a coding provider.',
    action: 'Allow this Mac app',
    expires: 'The authorization request expires after five minutes.',
  },
  ru: {
    heading: 'Разрешить GrantTap на этом Mac',
    detail: 'Приложению GrantTap для Mac нужен доступ к локальному сервису, чтобы показывать задачи, отправлять сообщения, обрабатывать одобрения и настраивать relay.',
    scope: 'Разрешение действует только для приложения на этом Mac. Оно не открывает доступ другому компьютеру или агенту.',
    action: 'Разрешить на этом Mac',
    expires: 'Запрос разрешения истечёт через пять минут.',
  },
} as const;

type Consent = { id: string; confirmation: string; state: string };

export function desktopConsentPage(row: Consent, language: string | undefined): string {
  const locale = language?.toLowerCase().startsWith('ru') ? 'ru' : 'en';
  const words = copy[locale];
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><title>GrantTap for Mac</title>
<link rel="stylesheet" href="/desktop/consent.css"></head><body>
<main class="consent-card"><div class="brand"><span class="brand-mark" aria-hidden="true">✓</span><span>GrantTap</span></div>
<h1>${words.heading}</h1><p>${words.detail}</p><p class="scope">${words.scope}</p>
<form action="/desktop/approve" method="post"><input type="hidden" name="id" value="${row.id}">
<input type="hidden" name="confirmation" value="${row.confirmation}">
<input type="hidden" name="state" value="${row.state}"><button type="submit">${words.action}</button></form>
<p class="footnote">${words.expires}</p></main></body></html>`;
}

export const desktopConsentStyles = `:root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light dark}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#f4f1ed;color:#211f1d}
.consent-card{width:min(100%,480px);padding:32px;border:1px solid #dfd8d0;border-radius:24px;background:#fff;box-shadow:0 16px 48px #20170e18}
.brand{display:flex;align-items:center;gap:10px;font-size:19px;font-weight:750}.brand-mark{display:grid;place-items:center;width:38px;height:38px;border-radius:10px;background:#f17b39;color:#17110e;font-size:26px}
h1{margin:32px 0 14px;font-size:27px;line-height:1.2;letter-spacing:-.025em}p{margin:0 0 18px;line-height:1.5;color:#56504a}
.scope{padding:15px 16px;border-radius:12px;background:#f4f1ed;color:#38332e}button{display:block;width:100%;margin-top:24px;padding:14px 18px;border:0;border-radius:12px;background:#ca4e24;color:white;font:inherit;font-weight:700;cursor:pointer}
button:hover{background:#a93c1b}button:focus-visible{outline:3px solid #2171d1;outline-offset:3px}.footnote{margin:18px 0 0;text-align:center;font-size:13px;color:#817a73}
@media(prefers-color-scheme:dark){body{background:#101114;color:#f5f2ef}.consent-card{background:#22252a;border-color:#3b3e45;box-shadow:0 16px 48px #0007}p{color:#bdb8b2}.scope{background:#30343a;color:#e0dad3}.footnote{color:#a39e98}}
`;
