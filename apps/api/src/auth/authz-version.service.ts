import { Global, Inject, Injectable, Logger, Module, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import Redis from 'ioredis';
import { PrismaClient } from '@openestate/db';
import { SYSTEM_PRISMA } from '../database/database.module';

/** Backstop only: every write path updates the cache itself (write-through). */
export const AUTHZ_VERSION_TTL_SECONDS = 60;
export const AUTHZ_REDIS_URL = 'AUTHZ_REDIS_URL';
const KEY = (userId: string) => `authz:v:${userId}`;

/**
 * Sets the key to ARGV[1] only if it is missing or holds a LOWER version, then
 * returns what the key holds. Versions only ever go up, so "keep the max" is
 * always right and two writers racing (a bump and a cache fill from an older
 * database read) can never leave a stale, lower value behind.
 */
const SET_MAX = `
local cur = redis.call('GET', KEYS[1])
if (not cur) or (tonumber(cur) < tonumber(ARGV[1])) then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
  return ARGV[1]
end
return cur
`;

/**
 * The per-user session authorisation version (users.authz_version), read on
 * every authenticated request by SessionVersionGuard and incremented by every
 * write path that must end existing sessions.
 *
 * Read path: one Redis GET. On a miss, one database read, then a SET_MAX into
 * Redis. If Redis is unreachable, the value is read from the database instead;
 * if the database is unreachable too the call throws, so the request fails
 * rather than being let through. Never fails open.
 *
 * Write path: the database UPDATE (the source of truth), then SET_MAX of the
 * new value into Redis in the same call. The cache is shared by every API
 * instance (no in-process cache), so all of them see the new value on the very
 * next request; the 60 s TTL only bounds staleness if a write to Redis failed.
 */
@Injectable()
export class AuthzVersionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuthzVersionService.name);
  private readonly redis: Redis;

  constructor(
    @Inject(SYSTEM_PRISMA) private readonly prisma: PrismaClient,
    @Optional() @Inject(AUTHZ_REDIS_URL) redisUrl?: string,
  ) {
    this.redis = new Redis(redisUrl ?? process.env.REDIS_URL ?? 'redis://localhost:6379', {
      // Fail fast instead of queueing commands while Redis is down, so a
      // request falls back to the database at once.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 1000,
    });
    this.redis.on('error', () => {
      // Reconnection is automatic; each failed command is logged at its call.
    });
  }

  /**
   * Commands are not queued while disconnected (enableOfflineQueue: false), so
   * until the first connection is up every read goes to the database and every
   * cache write fails. Waiting here (bounded, so a down Redis never blocks
   * startup) means a bump made right after startup reaches the cache, rather
   * than leaving a value cached before a restart in place until the TTL.
   */
  async onModuleInit() {
    await this.ready(2000);
  }

  /** Resolves once connected, or after `timeoutMs` (then reads use the database). */
  ready(timeoutMs = 2000): Promise<void> {
    if (this.redis.status === 'ready') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.redis.off('ready', done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.redis.once('ready', done);
    });
  }

  async onModuleDestroy() {
    this.redis.disconnect();
  }

  /** The user's current version, or null if the user no longer exists. */
  async current(userId: string): Promise<number | null> {
    let cached: string | null = null;
    try {
      cached = await this.redis.get(KEY(userId));
    } catch (err) {
      this.logger.warn(`authz version cache unavailable, reading the database (${(err as Error).message})`);
      return this.readDb(userId);
    }
    if (cached !== null) return Number(cached);

    const fromDb = await this.readDb(userId);
    if (fromDb === null) return null;
    try {
      return Number(await this.redis.eval(SET_MAX, 1, KEY(userId), String(fromDb), String(AUTHZ_VERSION_TTL_SECONDS)));
    } catch {
      return fromDb;
    }
  }

  /**
   * The user's version read from the database (null if the user is gone),
   * then raised into the cache. For a token newer than the cached value: a
   * bump made outside this service (the upgrade's permission sync) leaves the
   * cache behind until it expires.
   */
  async fromDatabase(userId: string): Promise<number | null> {
    const fromDb = await this.readDb(userId);
    if (fromDb !== null) await this.writeThrough([{ id: userId, authz_version: fromDb }]);
    return fromDb;
  }

  /** Ends every existing session of these users (their tokens carry the old version). */
  async bumpUsers(userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    const rows = await this.prisma.$queryRaw<Array<{ id: string; authz_version: number }>>`
      UPDATE users SET authz_version = authz_version + 1
      WHERE id = ANY(${userIds}::uuid[])
      RETURNING id, authz_version`;
    await this.writeThrough(rows);
  }

  /**
   * Writes a version already committed elsewhere (TokenService.endSessions,
   * which bumps under the per-user token lock) to the cache.
   */
  async publish(userId: string, version: number): Promise<void> {
    await this.writeThrough([{ id: userId, authz_version: version }]);
  }

  /** Ends every existing session of every user holding this role. */
  async bumpRole(roleId: string): Promise<void> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; authz_version: number }>>`
      UPDATE users SET authz_version = authz_version + 1
      WHERE role_id = ${roleId}::uuid
      RETURNING id, authz_version`;
    await this.writeThrough(rows);
  }

  private async readDb(userId: string): Promise<number | null> {
    const rows = await this.prisma.$queryRaw<Array<{ authz_version: number }>>`
      SELECT authz_version FROM users WHERE id = ${userId}::uuid`;
    return rows.length ? rows[0].authz_version : null;
  }

  /**
   * Runs only after the version UPDATE has committed: bumpUsers/bumpRole issue
   * it as its own statement (autocommit) and every caller invokes them after its
   * own business transaction has resolved, i.e. committed. If the cache write
   * fails while Redis is reachable, the key is deleted (best effort), so a read
   * goes back to the database instead of trusting a stale, lower value for up to
   * the TTL. If Redis is unreachable, reads already go to the database.
   */
  private async writeThrough(rows: Array<{ id: string; authz_version: number }>): Promise<void> {
    for (const r of rows) {
      try {
        await this.redis.eval(SET_MAX, 1, KEY(r.id), String(r.authz_version), String(AUTHZ_VERSION_TTL_SECONDS));
      } catch (err) {
        this.logger.warn(`authz version cache write failed for one user; deleting the key (${(err as Error).message})`);
        try {
          await this.redis.del(KEY(r.id));
        } catch (delErr) {
          this.logger.error(
            `authz version cache key could not be deleted either; it expires within ${AUTHZ_VERSION_TTL_SECONDS} s (${(delErr as Error).message})`,
          );
        }
      }
    }
  }
}

/** Global so the guard (registered in AppModule) and every service that ends sessions share one instance. */
@Global()
@Module({ providers: [AuthzVersionService], exports: [AuthzVersionService] })
export class AuthzVersionModule {}
