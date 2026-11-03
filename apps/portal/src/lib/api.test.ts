import { SESSION_ENDED_MESSAGE } from '@openestate/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mirror of apps/web/src/lib/api.test.ts — same bug, same root cause, same
// fix, in both clients (this project's mirrored-auth standing rule).
// api.ts holds accessToken/refreshPromise as module-scoped `let` state, not
// exported/resettable — vi.resetModules() + a fresh dynamic import per test
// gives each test its own clean instance instead of leaking state across
// tests in this file.
describe('refreshSession — concurrent-call de-dup', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonResponse(body: unknown) {
    return { ok: true, json: async () => body } as unknown as Response;
  }

  it('two concurrent calls make exactly one network request and both resolve to the same, consistent state', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(jsonResponse({ accessToken: token('token-a') }));

    const { refreshSession, getAccessToken } = await import('./api');

    const [first, second] = await Promise.all([refreshSession(), refreshSession()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first).toBe(token('token-a'));
    expect(second).toBe(token('token-a'));
    expect(getAccessToken()).toBe(token('token-a'));
  });

  it('a call after the first has resolved fires a new request — de-dup is scoped to concurrency, not a permanent cache', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ accessToken: token('token-a') }))
      .mockResolvedValueOnce(jsonResponse({ accessToken: token('token-b') }));

    const { refreshSession } = await import('./api');

    const tokenA = await refreshSession();
    const tokenB = await refreshSession();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(tokenA).toBe(token('token-a'));
    expect(tokenB).toBe(token('token-b'));
  });

  it('a failed refresh among concurrent callers resolves every caller to null, never a half-set session', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({ ok: false } as unknown as Response);

    const { refreshSession, getAccessToken } = await import('./api');

    const [first, second] = await Promise.all([refreshSession(), refreshSession()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(getAccessToken()).toBeNull();
  });
});

function token(label: string) {
  return `header.${btoa(JSON.stringify({ sub: label === 'B' || label === 'fresh-B' ? 'user-b' : 'user-a',
    companyId: 'company-a', surface: 'portal', email: `${label}@example.test`, roleSlug: 'test', permissions: [], av: 1, applicantId: 'customer-a' }))}.signature`;
}

it('a refresh started before an account switch cannot overwrite the new token', async () => {
  vi.resetModules();
  let resolve!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(r => { resolve = r; })));
  try {
    const { setAccessToken, refreshSession, getAccessToken } = await import('./api');
    setAccessToken(token('A'));
    const pending = refreshSession();
    setAccessToken(null);
    setAccessToken(token('B'));
    resolve({ ok: true, json: async () => ({ accessToken: token('late-A') }) } as Response);
    await pending;
    expect(getAccessToken()).toBe(token('B'));
  } finally { vi.unstubAllGlobals(); }
});

describe('obsolete session requests', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('document', { cookie: '' });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('rejects an old response even when its body finishes after the account switch', async () => {
    let finishBody!: (body: unknown) => void;
    let bodyStarted!: () => void;
    const started = new Promise<void>(resolve => { bodyStarted = resolve; });
    const body = new Promise(resolve => { finishBody = resolve; });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: () => {
      bodyStarted();
      return body;
    } })));
    const { api, setAccessToken } = await import('./api');
    setAccessToken(token('A'));
    const pending = api('/private');
    await started;
    setAccessToken(token('B'));
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    finishBody({ privateName: token('A') });
    await rejected;
  });

  it('does not refresh or end B when an old A request returns 401', async () => {
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }))
      .mockResolvedValue({ ok: false } as Response);
    vi.stubGlobal('fetch', fetchMock);
    const { api, setAccessToken, onSessionEnded } = await import('./api');
    const ended = vi.fn();
    onSessionEnded(ended);
    setAccessToken(token('A'));
    const pending = api('/private');
    setAccessToken(token('B'));
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    finish({ ok: false, status: 401, json: async () => ({ message: SESSION_ENDED_MESSAGE }) } as Response);
    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ended).not.toHaveBeenCalled();
  });

  it('keeps the new session refresh deduplicated when the old refresh settles', async () => {
    const finish: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(() => new Promise<Response>(resolve => { finish.push(resolve); }));
    vi.stubGlobal('fetch', fetchMock);
    const { setAccessToken, refreshSession, getAccessToken } = await import('./api');
    setAccessToken(token('A'));
    const old = refreshSession();
    setAccessToken(token('B'));
    const current = refreshSession();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    finish[0]({ ok: true, json: async () => ({ accessToken: token('late-A') }) } as Response);
    await old;
    expect(refreshSession()).toBe(current);
    finish[1]({ ok: true, json: async () => ({ accessToken: token('fresh-B') }) } as Response);
    await current;
    expect(getAccessToken()).toBe(token('fresh-B'));
  });
});

describe('abandoned portal binary responses', () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each(['download', 'inline image'])('does not expose an old %s after its blob completes', async kind => {
    vi.resetModules();
    let finish!: (blob: Blob) => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const blob = new Promise<Blob>(resolve => { finish = resolve; });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, blob: () => { started(); return blob; } })));
    const createObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL });
    const { setAccessToken, downloadFile, fetchAsObjectUrl } = await import('./api');
    setAccessToken(token('A'));
    const pending = kind === 'download' ? downloadFile('/private', 'private.pdf') : fetchAsObjectUrl('/private');
    await ready;
    setAccessToken(token('B'));
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    finish(new Blob(['private A']));
    await rejected;
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
