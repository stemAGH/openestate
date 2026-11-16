import { maskPhonesInText } from '@openestate/shared';

/**
 * pino redaction paths. Extended as new PII-bearing fields are introduced
 * (CLAUDE.md: PAN/phone must never reach logs unmasked).
 */
export const LOG_REDACTION_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body.password',
  'req.body.newPassword',
  'req.body.currentPassword',
  'req.body.token',
  'req.body.refreshToken',
  'req.body.pan',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.secret',
  '*.pan',
];

/** Decodes a URL for masking (%2B91%2098765… or +91+98765… is still a phone number). */
function decodeForLog(url: string): string {
  try {
    return decodeURIComponent(url.replace(/\+/g, ' '));
  } catch {
    return url;
  }
}

/**
 * pino-http request serializer: phone numbers typed into a search box end up
 * in the URL and query string (e.g. GET /inquiries?search=9876543210), which
 * the redaction paths above can't reach inside. Masks them to the last 4
 * digits, like list views. Path segments such as UUIDs are left alone.
 *
 * The Referer header too: the staff app keeps its search in its own address
 * (?q=…), which a browser sends as the Referer of every API call. The apps
 * now ask browsers not to send it (Referrer-Policy no-referrer); this covers
 * older cached pages and any other client.
 */
export function serializeRequestForLog<T extends { url?: string; query?: unknown; headers?: unknown }>(req: T): T {
  const headers = req.headers as Record<string, unknown> | undefined;
  return {
    ...req,
    ...(typeof req.url === 'string' ? { url: maskPhonesInText(decodeForLog(req.url)) } : {}),
    ...(headers && typeof headers.referer === 'string'
      ? { headers: { ...headers, referer: maskPhonesInText(decodeForLog(headers.referer)) } }
      : {}),
    ...(req.query && typeof req.query === 'object'
      ? {
          query: Object.fromEntries(
            Object.entries(req.query).map(([k, v]) => [k, typeof v === 'string' ? maskPhonesInText(v) : v]),
          ),
        }
      : {}),
  };
}
