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
    .find((c) => c.startsWith('openestate_portal_csrf='));
  return match ? match.split('=')[1] : null;
}

// Compare continuity only; JWT signature and authorization checks remain on the server.
function tokenIdentity(token: string): string | null {
  try {
    const payload: JwtPayload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (typeof payload.sub !== 'string' || !payload.sub ||
        typeof payload.companyId !== 'string' || !payload.companyId || payload.surface !== 'portal') return null;
    const customer = typeof payload.applicantId === 'string' && !!payload.applicantId;
    const broker = typeof payload.brokerId === 'string' && !!payload.brokerId;
    if (customer === broker) return null;
    return JSON.stringify([payload.sub, payload.companyId, payload.surface, payload.applicantId ?? null, payload.brokerId ?? null]);
  } catch {
    return null;
  }
}

async function refreshAccessToken(): Promise<string | null> {
  const signal = sessionController.signal;
  const previousToken = accessToken;
  try {
    const res = await fetch(`${API_BASE}/api/v1/portal/auth/refresh`, {
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
 * De-duped refresh — see apps/web/src/lib/api.ts's identical function for
 * the full explanation (same bug, same root cause, same fix, in both
 * clients, per this project's mirrored-auth standing rule). Every caller
 * wanting a fresh session shares ONE in-flight /portal/auth/refresh
 * request instead of racing its own.
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
  if (!headers.has('Content-Type') && options.body) {
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
      // /portal/auth/refresh rotates the CSRF cookie (a new random value on
      // every call — see portal-auth.controller.ts), so the `csrf` value
      // read above, before this refresh happened, is now stale. See
      // apps/web/src/lib/api.ts's identical fix for the full explanation —
      // same bug, same root cause, same fix, in both clients.
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

/** Same "fetch as blob, download via object URL" pattern as apps/web — the
 * Bearer token lives in memory only, so a plain <a href> can't carry it. */
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
    // deliberately swallow this error to avoid blocking their own flow,
    // which would otherwise leave the user with zero feedback.
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

/**
 * Fetches an authenticated binary response as a blob object URL, for
 * rendering inline (an <img src>) rather than triggering a save-as
 * download — v0.2.2's project/construction-progress photo galleries.
 * Caller owns the returned URL and must URL.revokeObjectURL() it when
 * done (see Property.tsx's AuthedImage, which does this on unmount).
 */
export async function fetchAsObjectUrl(path: string): Promise<string> {
  const url = `${API_BASE}/api/v1${path}`;
  const signal = sessionController.signal;
  const headers = new Headers();
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  const res = await fetch(url, { headers, credentials: 'include', signal });
  signal.throwIfAborted();
  if (!res.ok) throw new Error(`Failed to load image: ${res.status}`);
  const blob = await res.blob();
  signal.throwIfAborted();
  return URL.createObjectURL(blob);
}
