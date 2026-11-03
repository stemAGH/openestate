import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JwtPayload } from '@openestate/shared';
import * as client from './api';

const identity: JwtPayload = { sub: '00000000-0000-4000-8000-000000000001',
  companyId: '00000000-0000-4000-8000-000000000010', surface: 'portal',
  email: 'synthetic@example.test', roleSlug: 'test', permissions: [], av: 1, applicantId: 'customer-a' };
function token(change: Partial<JwtPayload> = {}) {
  return `header.${btoa(JSON.stringify({ ...identity, ...change }))}.signature`;
}
function response(accessToken: string) {
  return { ok: true, json: async () => ({ accessToken }) } as Response;
}
let api: typeof client;
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('document', { cookie: '' });
  vi.stubGlobal('fetch', vi.fn());
  api = await import('./api');
});
afterEach(() => vi.unstubAllGlobals());

describe('refresh identity continuity', () => {
  it('restores an initial session without an established local identity', async () => {
    vi.mocked(fetch).mockResolvedValue(response(token()));
    expect(await api.refreshSession()).toBe(token());
  });
  it('preserves a same-identity session when ordinary token claims change', async () => {
    api.setAccessToken(token());
    const epoch = api.getSessionEpoch();
    const fresh = token({ av: 2, iat: 20, exp: 200, permissions: ['changed'] });
    vi.mocked(fetch).mockResolvedValue(response(fresh));
    const ended = vi.fn(); api.onSessionEnded(ended);
    expect(await api.refreshSession()).toBe(fresh);
    expect(api.getAccessToken()).toBe(fresh);
    expect(api.getSessionEpoch()).toBe(epoch);
    expect(ended).not.toHaveBeenCalled();
  });
  it.each([
    ['user', { sub: '00000000-0000-4000-8000-000000000002' }],
    ['company', { companyId: '00000000-0000-4000-8000-000000000020' }],
    ['surface', { surface: 'staff' }],
    ['missing surface', { surface: undefined }],
    ['applicant', { applicantId: 'customer-b' }],
    ['principal kind', { applicantId: undefined, brokerId: 'broker-a' }],
  ] as Array<[string, Partial<JwtPayload>]>)('ends only the local session on a different %s', async (_, change) => {
    api.setAccessToken(token());
    const ended = vi.fn(); api.onSessionEnded(ended);
    vi.mocked(fetch).mockResolvedValue(response(token(change)));
    expect(await api.refreshSession()).toBeNull();
    expect(api.getAccessToken()).toBeNull();
    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended.mock.calls[0][0]).not.toContain(identity.email);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toMatch(/auth\/refresh$/);
  });
  it.each(['GET', 'POST'])('never replays an old %s request under the replacement account', async method => {
    api.setAccessToken(token());
    vi.mocked(fetch).mockResolvedValueOnce({ status: 401, ok: false } as Response)
      .mockResolvedValueOnce(response(token({ sub: 'replacement-user' })))
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ private: 'B' }) } as Response);
    const pending = api.api('/private', { method, ...(method === 'POST' ? { body: JSON.stringify({ private: 'A' }) } : {}) });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(api.getAccessToken()).toBeNull();
  });
  it.each(['logout', 'login'])('ignores an old refresh after local %s, even if fetch ignores cancellation', async transition => {
    api.setAccessToken(token());
    let finish!: (res: Response) => void;
    vi.mocked(fetch).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const ended = vi.fn(); api.onSessionEnded(ended);
    const pending = api.refreshSession();
    const next = transition === 'logout' ? null : token({ sub: 'replacement-user' });
    api.setAccessToken(next);
    finish(response(token()));
    expect(await pending).toBeNull();
    expect(api.getAccessToken()).toBe(next);
    expect(ended).not.toHaveBeenCalled();
  });
  it('deduplicates concurrent mismatched refreshes and ends the local session once', async () => {
    api.setAccessToken(token());
    const ended = vi.fn(); api.onSessionEnded(ended);
    vi.mocked(fetch).mockResolvedValue(response(token({ sub: 'replacement-user' })));
    expect(await Promise.all([api.refreshSession(), api.refreshSession()])).toEqual([null, null]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(ended).toHaveBeenCalledTimes(1);
  });
});

it('rejects malformed refresh identity without installing it', async () => {
  api.setAccessToken(token());
  vi.mocked(fetch).mockResolvedValue(response('malformed'));
  expect(await api.refreshSession()).toBeNull();
  expect(api.getAccessToken()).toBeNull();
});
