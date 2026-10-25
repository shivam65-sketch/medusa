// Small helpers shared by the API files: JSON responses with safe headers, and request bodies.

export const SECURITY = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',   // browsers use HTTPS only, for a year
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

export const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY, ...extra },
  });

export const fail = (status, error, more = {}) => json({ error, ...more }, status);

export const readBody = (req) => req.json().catch(() => ({}));

/* ---------- error pages, for a person who opens an address in the browser ---------- */

/** True when a person opened the address in the browser (typed it, followed a link), not when the app's
 * own code or another program called it. Those get the JSON error; a person gets a page. */
export const wantsPage = (req) => (req.method === 'GET' || req.method === 'HEAD')
  && (req.headers.get('sec-fetch-mode') === 'navigate'
    || (/\btext\/html\b/.test(req.headers.get('accept') || '') && !req.headers.get('x-requested-with')));

const PAGES = {
  401: ['Sign in to continue', 'This part of MEDUSA is for signed-in accounts. Sign in, and you\'ll find it in the app.', 'Sign in'],
  403: ['Not allowed', 'This address can\'t be opened from here.', 'Go to MEDUSA'],
  404: ['Page not found', 'There\'s nothing at this address. It may have moved, or the link may be mistyped.', 'Go to MEDUSA'],
  500: ['Something went wrong', 'MEDUSA couldn\'t answer just now. Try again in a moment.', 'Go to MEDUSA'],
};

/** The error as a page in MEDUSA's own look (the sign-in card's), with the same status code. Everything
 * it needs is inline, so its policy can forbid any script. */
export function errorPage(status) {
  const [title, text, button] = PAGES[status] || PAGES[status >= 500 ? 500 : 404];
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · MEDUSA</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 20px; background: #1c1c1c; color: #f4f4f5;
         font: 400 15px/1.5 "Segoe UI", system-ui, -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif; -webkit-font-smoothing: antialiased; }
  main { width: min(400px, 100%); display: grid; gap: 14px; padding: 30px 26px; border-radius: 14px; background: #252525; border: 1px solid #3c3c3c; }
  .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 6px; }
  .brand img { width: 48px; height: 48px; }
  .brand span { font-size: 28px; font-weight: 800; letter-spacing: 0.08em; line-height: 1; }
  .code { color: #8b8b91; font-size: 13px; font-variant-numeric: tabular-nums; letter-spacing: 0.04em; }
  h1 { margin: 0; font-size: 21px; font-weight: 700; }
  p { margin: 0; color: #b4b4b8; }
  a { justify-self: start; margin-top: 6px; display: inline-flex; align-items: center; height: 40px; padding: 0 18px; border-radius: 8px;
      background: #16a34a; color: #fff; font-weight: 600; text-decoration: none; }
  a:hover { background: #15803d; }
  a:focus-visible { outline: 2px solid #22c55e; outline-offset: 2px; }
</style>
</head>
<body>
<main>
  <div class="brand"><img src="/medusa.svg" alt="" width="48" height="48"><span>MEDUSA</span></div>
  <div class="code">Error ${status}</div>
  <h1>${title}</h1>
  <p>${text}</p>
  <a href="/">${button}</a>
</main>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      ...SECURITY,
    },
  });
}
