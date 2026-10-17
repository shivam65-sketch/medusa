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
