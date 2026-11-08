import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { HealthModule } from './health/health.module';
import { ForeignKeyRefusalFilter } from './common/filters/foreign-key-refusal.filter';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { RolesModule } from './roles/roles.module';
import { MastersModule } from './masters/masters.module';
import { CustomFieldsModule } from './custom-fields/custom-fields.module';
import { CompanyModule } from './company/company.module';
import { AuditModule } from './audit/audit.module';
import { InventoryModule } from './inventory/inventory.module';
import { PresalesModule } from './presales/presales.module';
import { PostsalesModule } from './postsales/postsales.module';
import { PdfModule } from './pdf/pdf.module';
import { DispatchModule } from './dispatch/dispatch.module';
import { PostsalesReportsModule } from './reports/postsales-reports.module';
import { BrokerReportsModule } from './reports/broker-reports.module';
import { BrokersModule } from './brokers/brokers.module';
import { CommissionModule } from './commission/commission.module';
import { QueuesModule } from './queues/queues.module';
import { NotificationModule } from './notifications/notification.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { TwoFactorPendingGuard } from './auth/guards/two-factor-pending.guard';
import { SessionSurfaceGuard } from './auth/guards/session-surface.guard';
import { SessionVersionGuard } from './auth/guards/session-version.guard';
import { AuthzVersionModule } from './auth/authz-version.service';
import { DefaultThrottlerGuard } from './auth/guards/default-throttler.guard';
import { TenantContextInterceptor } from './auth/interceptors/tenant-context.interceptor';
import { PermissionsGuard } from './auth/guards/permissions.guard';
import { CsrfGuard } from './auth/csrf.guard';
import { RedisThrottlerStorage } from './common/redis-throttler-storage';
import { PortalAuthModule } from './portal-auth/portal-auth.module';
import { CustomerPortalModule } from './customer-portal/customer-portal.module';
import { BrokersPortalModule } from './brokers-portal/brokers-portal.module';
import { PluginsModule } from './plugins/plugins.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { LeadsModule } from './leads/leads.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { LOG_REDACTION_PATHS, serializeRequestForLog } from './common/logger/redaction';

@Module({
  imports: [
    AuthzVersionModule,
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        redact: { paths: LOG_REDACTION_PATHS, censor: '[REDACTED]' },
        // Masks phone numbers in the logged URL and query (search boxes).
        serializers: { req: serializeRequestForLog },
        autoLogging: true,
      },
    }),
    // Single, application-wide registration of every named throttler
    // bucket (the unnamed/'default' staff bucket, plus PortalAuthModule's
    // 'portal-auth'/'portal-read' buckets) — see DefaultThrottlerGuard's
    // doc comment for why there must be exactly ONE ThrottlerModule.forRoot()
    // call anywhere in this app's module graph: @nestjs/throttler's
    // ThrottlerModule is @Global(), so a SECOND forRoot() call (as
    // PortalAuthModule's own used to be) creates a second, competing
    // global THROTTLER_OPTIONS registration — which of the two "wins" for
    // any given consumer is compile-order-dependent, not something to
    // rely on (empirically proven flaky by a real bug this fixes: the
    // portal-read rate-limit test intermittently either leaked the tiny
    // portal-auth bucket onto every staff/portal-read route, or caused
    // PortalAuthThrottlerGuard's own bucket to silently stop enforcing).
    ThrottlerModule.forRootAsync({
      // Phase 8: Redis-backed, not @nestjs/throttler's in-memory default
      // (closes the Phase 1/6/7 docs/todo.md gap — rate-limit state now
      // survives a restart and is shared across replicas, for all four
      // buckets below at once since they share this one registration).
      // See RedisThrottlerStorage's own doc comment for why this is
      // hand-rolled on the existing ioredis dependency rather than a new
      // package.
      //
      // forRootAsync + useFactory, NOT forRoot's plain `storage: new
      // RedisThrottlerStorage()` — a plain value is only constructed ONCE,
      // at @Module({imports:[...]}) decorator-evaluation time, which Node
      // caches on the module (require('../dist/app.module') resolves to
      // the SAME AppModule class, and therefore the SAME storage instance
      // and its ONE ioredis connection, across every NestFactory.create()
      // call in a process — real bug, caught by this phase's own e2e test:
      // closing one app instance ran RedisThrottlerStorage's
      // onApplicationShutdown() and disconnected the ioredis client that
      // every OTHER already-running or later-created app instance in the
      // same process also depended on, throwing "Connection is closed" on
      // their very next throttled request. useFactory runs fresh at
      // application-bootstrap time (once per NestFactory.create() call,
      // via that app's own DI container), giving each app instance its
      // own RedisThrottlerStorage and its own connection — the correct
      // ownership boundary regardless of the test-only symptom that
      // surfaced it.
      useFactory: () => ({
        storage: new RedisThrottlerStorage(),
        throttlers: [
          { ttl: 60_000, limit: Number(process.env.DEFAULT_THROTTLE_LIMIT ?? 100) },
          // Env-configurable for the same reason DEFAULT_THROTTLE_LIMIT
          // above is: this bucket is IP-keyed, and the whole Playwright
          // harness shares ONE API process and therefore ONE budget for
          // its entire run — apps/e2e/fixtures/seed.ts's own comment
          // records real, intermittent 429s on unrelated spec files once
          // the suite's total portal login count crossed 5. Unset in a
          // real install this stays 5, unchanged.
          {
            name: 'portal-auth',
            ttl: 300_000,
            limit: Number(process.env.PORTAL_AUTH_THROTTLE_LIMIT ?? 5),
          },
          { name: 'portal-read', ttl: 60_000, limit: 60 },
          // Password-change/reset-confirm across staff and portal — see
          // PasswordChangeThrottlerGuard's doc comment for why one bucket
          // covers all three routes.
          { name: 'password-change', ttl: 300_000, limit: 5 },
          // Second-factor attempts on staff and portal totp/verify, per
          // user (TotpVerifyThrottlerGuard). Same window and limit as
          // portal-auth, and env-configurable for the same test-harness
          // reason; unset in a real install it stays 5.
          {
            name: 'totp-verify',
            ttl: 300_000,
            limit: Number(process.env.TOTP_VERIFY_THROTTLE_LIMIT ?? 5),
          },
          // Phase 7 commit 2: per-API-key limit, not a global constant —
          // the resolver reads the LeadApiKeyGuard-populated
          // req.leadApiKey (that guard runs first in the route's guard
          // chain). Falls back to 60 for any request that somehow reaches
          // here without a resolved key (defense-in-depth; LeadApiKeyGuard
          // already rejects those with a 401 before this throttler would
          // matter).
          {
            name: 'lead-inbound',
            ttl: 60_000,
            limit: (context) => context.switchToHttp().getRequest().leadApiKey?.rateLimitPerMinute ?? 60,
          },
        ],
      }),
    }),
    DatabaseModule,
    HealthModule,
    AuthModule,
    UsersModule,
    RolesModule,
    MastersModule,
    CustomFieldsModule,
    CompanyModule,
    AuditModule,
    QueuesModule,
    NotificationModule,
    InventoryModule,
    PresalesModule,
    PostsalesModule,
    PdfModule,
    DispatchModule,
    PostsalesReportsModule,
    BrokerReportsModule,
    BrokersModule,
    CommissionModule,
    PortalAuthModule,
    CustomerPortalModule,
    BrokersPortalModule,
    PluginsModule,
    WebhooksModule,
    LeadsModule,
    DashboardModule,
  ],
  providers: [
    // Filtered to the unnamed/'default' bucket only — see
    // DefaultThrottlerGuard's doc comment for the real bug (Phase 6
    // commit 4) this fixes: ThrottlerModule is @Global(), so the plain
    // ThrottlerGuard class would otherwise pick up PortalAuthModule's
    // 'portal-auth'/'portal-read' buckets too and enforce them on every
    // route in the app, including staff routes.
    { provide: APP_GUARD, useClass: DefaultThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Straight after JwtAuthGuard (global guards run in registration
    // order): a 2FA-pending token is refused on every route except
    // totp/verify, before CSRF or permissions are even looked at. Global,
    // so no controller can opt out — see the guard's doc comment.
    { provide: APP_GUARD, useClass: TwoFactorPendingGuard },
    // Ends a session the moment it stops being authorised (deactivated, role or
    // its permissions changed, password changed or reset, 2FA reset) instead of
    // letting the access token live out its 15 minutes. See the guard.
    { provide: APP_GUARD, useClass: SessionVersionGuard },
    { provide: APP_GUARD, useClass: SessionSurfaceGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    // Establishes ambient tenant/portal context for the rest of the
    // request. Runs as a global INTERCEPTOR, not a guard — Nest's fixed
    // pipeline order is middleware → guards → interceptors → pipes →
    // handler, so interceptors always run after every guard regardless
    // of registration order, guaranteeing req.user (set by JwtAuthGuard)
    // is populated here. See TenantContextInterceptor's doc comment and
    // CLAUDE.md Phase 6 commit 2 decisions for why this replaced both
    // Express middleware (ran before guards — req.user never existed)
    // AND a first attempt at a Guard using enterWith (context was lost
    // across prisma.$transaction()'s internal async boundary).
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
    // v0.8.4: a plain 409 for the three ON DELETE RESTRICT foreign keys
    // (installment with interest charged, interest rule in use). Every
    // other error is passed to Nest's default handling unchanged.
    { provide: APP_FILTER, useClass: ForeignKeyRefusalFilter },
  ],
})
export class AppModule {}
