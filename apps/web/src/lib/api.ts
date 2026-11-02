import { SESSION_ENDED_MESSAGE, type JwtPayload } from '@openestate/shared';
import { toast } from './toast';

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

let accessToken: string | null = null;
let refreshPromise: Promise<string | null> | null = null;
let sessionEpoch = 0;
let sessionController = new AbortController();
let sessionEndedHandler: ((message: string) => void) | null = null;

/**
 * Registered by AuthProvider. Called when a request is refused because the
 * session has ended (deactivated, password changed elsewhere, role changed...)
 * and the refresh token can't renew it either, so the user is sent to the
 * sign-in page with the server's message instead of being left on a page whose
 * every request now fails.
 */
export function onSessionEnded(handler: ((message: string) => void) | null) {
  sessionEndedHandler = handler;
}

// Explicit authentication changes start a new boundary; ordinary refresh stays inside it.
export function setAccessToken(token: string | null) {
  sessionController.abort();
  sessionController = new AbortController();
  sessionEpoch += 1;
  refreshPromise = null;
  accessToken = token;
  toast.clear();
}

export function getSessionEpoch() {
  return sessionEpoch;
}

export function getAccessToken() {
  return accessToken;
}

function getCsrfToken(): string | null {
  const match = document.cookie
    .split('; ')
    .find((c) => c.startsWith('openestate_csrf='));
  return match ? match.split('=')[1] : null;
}

// Compare continuity only; JWT signature and authorization checks remain on the server.
function tokenIdentity(token: string): string | null {
  try {
    const payload: JwtPayload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (typeof payload.sub !== 'string' || !payload.sub ||
        typeof payload.companyId !== 'string' || !payload.companyId || payload.surface !== 'staff') return null;

    return JSON.stringify([payload.sub, payload.companyId, payload.surface]);
  } catch {
    return null;
  }
}

async function refreshAccessToken(): Promise<string | null> {
  const signal = sessionController.signal;
  const previousToken = accessToken;
  try {
    const res = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    signal.throwIfAborted();
    const identity = tokenIdentity(data.accessToken);
    if (!identity || (previousToken !== null && identity !== tokenIdentity(previousToken))) {
      // The shared cookie may belong to another tab; never revoke its server session.
      setAccessToken(null);
      sessionEndedHandler?.('Your session has changed. Please sign in again.');
      return null;
    }
    accessToken = data.accessToken;
    return accessToken;
  } catch {
    return null;
  }
}

/**
 * De-duped refresh: every caller wanting a fresh session — AuthProvider's
 * mount-time check, and api()'s own 401-retry below — shares ONE in-flight
 * /auth/refresh request instead of firing its own. Without this,
 * React.StrictMode's dev-mode double-effect-invocation (or, in production,
 * two components independently needing a fresh session at the same
 * moment) fires two concurrent refreshes; the second one 401s once the
 * first has already rotated the refresh cookie, and if it resolves after
 * the first, its failure silently overwrites the just-established session.
 * See CLAUDE.md's apps/e2e entry for the bug this was caught by.
 */
export function refreshSession(): Promise<string | null> {
  if (!refreshPromise) {
    const pending = refreshAccessToken().finally(() => {
      if (refreshPromise === pending) refreshPromise = null;
    });
    refreshPromise = pending;
  }
  return refreshPromise;
}

export async function api<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${API_BASE}/api/v1${path}`;

  const signal = options.signal
    ? AbortSignal.any([sessionController.signal, options.signal])
    : sessionController.signal;
  signal.throwIfAborted();

  const headers = new Headers(options.headers);
  // FormData (file uploads) must NOT get an explicit Content-Type — the
  // browser sets multipart/form-data with the correct boundary itself;
  // overriding it here would break every field the browser encodes.
  if (!headers.has('Content-Type') && options.body && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  if (accessToken) {
    headers.set('Authorization', `Bearer ${accessToken}`);
  }
  const csrf = getCsrfToken();
  if (csrf) {
    headers.set('X-CSRF-Token', csrf);
  }

  let res = await fetch(url, {
    ...options,
    headers,
    credentials: 'include',
    signal,
  });
  signal.throwIfAborted();

  let refreshFailed = false;
  if (res.status === 401 && accessToken) {
    const newToken = await refreshSession();
    signal.throwIfAborted();
    if (!newToken) refreshFailed = true;
    if (newToken) {
      headers.set('Authorization', `Bearer ${newToken}`);
      // /auth/refresh rotates the CSRF cookie (a new random value on every
      // call — see auth.controller.ts), so the `csrf` value read above,
      // before this refresh happened, is now stale. Re-reading here is not
      // optional: retrying with the old header value sends a real,
      // well-formed token that simply no longer matches the now-rotated
      // cookie, which CsrfGuard correctly rejects as "CSRF token mismatch"
      // — not "missing", a genuine mismatch. This is the bug that made
      // every mutation right after an access-token expiry (~15 min into a
      // session, whenever JWT_ACCESS_EXPIRES_IN elapses) fail with a CSRF
      // error on the VM.
      const refreshedCsrf = getCsrfToken();
      if (refreshedCsrf) {
        headers.set('X-CSRF-Token', refreshedCsrf);
      }
      res = await fetch(url, { ...options, headers, credentials: 'include', signal });
      signal.throwIfAborted();
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    signal.throwIfAborted();
    if (res.status === 401 && refreshFailed && body.message === SESSION_ENDED_MESSAGE) {
      setAccessToken(null);
      sessionEndedHandler?.(SESSION_ENDED_MESSAGE);
    }
    const err = new Error(body.message ?? `API error ${res.status}`);
    (err as ApiError).status = res.status;
    (err as ApiError).body = body;
    throw err;
  }

  if (res.status === 204) return undefined as T;
  const data = await res.json();
  signal.throwIfAborted();
  return data;
}

export interface ApiError extends Error {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Downloads a binary response (PDF, CSV) through the same auth as `api()`.
 * A plain `window.open`/`<a href>` navigation can't carry the in-memory
 * Bearer token (by design — CLAUDE.md keeps it out of cookies/localStorage),
 * so protected binary endpoints must be fetched here and opened as a blob
 * URL instead.
 */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const url = `${API_BASE}/api/v1${path}`;
  const signal = sessionController.signal;
  const headers = new Headers();
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);

  const res = await fetch(url, { headers, credentials: 'include', signal });
  signal.throwIfAborted();
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    signal.throwIfAborted();
    const message = body.message ?? `Download failed: ${res.status}`;
    // Not a TanStack Query mutation, so MutationCache's global onError
    // (main.tsx) never sees this — toast here directly. Several call sites
    // deliberately swallow this error to avoid blocking their own flow
    // (e.g. a saved receipt whose PDF failed to generate), which would
    // otherwise leave the user with zero feedback that the download failed.
    toast.error(message);
    throw new Error(message);
  }

  const blob = await res.blob();
  signal.throwIfAborted();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}
