/**
 * A phone number typed into a search box reaches the request log through the
 * URL and query string. This starts the compiled API as its own process
 * (pino writes straight to the stdout file descriptor, so an in-process spy
 * would see nothing), sends searches in the forms a browser produces, and
 * reads the real log lines.
 *
 * Requires the compiled dist/ — see e2e-company-update.test.ts for why.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

const PHONE = '9876543210';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

describeIf('e2e request logs mask phone numbers in the URL and query', () => {
  let child: ChildProcess;
  let base = '';
  let out = '';

  beforeAll(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}/api/v1`;
    child = spawn(process.execPath, ['dist/main.js'], {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        LOG_LEVEL: 'info',
        PORT: String(port),
        DATABASE_URL: APP_URL,
        DATABASE_URL_SYSTEM: SYSTEM_URL,
        REDIS_URL: process.env.REDIS_TEST_URL ?? 'redis://localhost:6379',
        JWT_ACCESS_SECRET: 'e2e-test-access-secret-0123456789',
        JWT_REFRESH_SECRET: 'e2e-test-refresh-secret-0123456789',
        PAN_ENCRYPTION_KEY: 'a1b2c3d4'.repeat(8),
        TOTP_ENCRYPTION_KEY: 'e5f6a7b8'.repeat(8),
        PLUGIN_SECRET_ENCRYPTION_KEYS: `1:${'c9d8e7f6'.repeat(8)}`,
        CORS_ALLOWLIST: 'http://localhost:5174',
        SWAGGER_ENABLED: 'false',
        THROTTLE_TEST_KEY_PREFIX: `e2e-log-mask-${process.pid}-${Date.now()}-`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', (d) => (out += d.toString('utf8')));
    child.stderr!.on('data', (d) => (out += d.toString('utf8')));
    for (let i = 0; i < 120; i++) {
      try {
        if ((await fetch(`${base}/health`)).ok) return;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`API did not start:\n${out.slice(-2000)}`);
  }, 90_000);

  afterAll(() => {
    child?.kill();
  });

  const searches = [
    `search=${PHONE}`,
    `search=%2B91%2098765%2043210`, // "+91 98765 43210", percent-encoded
    `search=%2B91+98765+43210`, // form-encoded spaces
    `search=098765-43210`,
  ];

  it.each(searches)('GET /inquiries?%s is logged with the number masked', async (qs) => {
    const marker = `mk${Math.random().toString(36).slice(2, 8)}`;
    // Unauthenticated: a 401 is still logged, with the full URL.
    await fetch(`${base}/inquiries?${qs}&projectId=${marker}`);
    let lines: string[] = [];
    for (let i = 0; i < 40 && lines.length === 0; i++) {
      lines = out.split('\n').filter((l) => l.includes(marker));
      if (lines.length === 0) await new Promise((r) => setTimeout(r, 100));
    }
    expect(lines.length, 'a log line for the request').toBeGreaterThan(0);
    for (const line of lines) {
      const squashed = line.replace(/%20|%2B|[\s+-]/gi, '');
      expect(squashed, line).not.toContain('98765');
      expect(line).toContain('••••••3210');
    }
  });

  // The staff app keeps its search in its own address (?q=…), and a browser
  // sends that address as the Referer of every API call it makes.
  it.each([
    `http://192.0.2.10/presales/inquiries?q=%2B91+98765+43210`,
    `http://192.0.2.10/presales/inquiries?q=${PHONE}&status=OPEN`,
  ])('a Referer of %s is logged with the number masked', async (referer) => {
    const marker = `mk${Math.random().toString(36).slice(2, 8)}`;
    await fetch(`${base}/inquiries?projectId=${marker}`, { headers: { Referer: referer } });
    let lines: string[] = [];
    for (let i = 0; i < 40 && lines.length === 0; i++) {
      lines = out.split('\n').filter((l) => l.includes(marker));
      if (lines.length === 0) await new Promise((r) => setTimeout(r, 100));
    }
    expect(lines.length, 'a log line for the request').toBeGreaterThan(0);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { req?: { headers?: { referer?: string } } };
      expect(parsed.req?.headers?.referer, 'the referer is still logged').toBeTruthy();
      const squashed = line.replace(/%20|%2B|[\s+-]/gi, '');
      expect(squashed, line).not.toContain('98765');
      expect(parsed.req!.headers!.referer).toContain('••••••3210');
    }
  });

  it('leaves UUIDs in the path alone', async () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    await fetch(`${base}/inquiries/${id}`);
    await new Promise((r) => setTimeout(r, 300));
    expect(out).toContain(`/inquiries/${id}`);
  });
});
