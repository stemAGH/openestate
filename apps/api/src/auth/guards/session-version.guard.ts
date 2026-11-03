import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { SESSION_ENDED_MESSAGE, type JwtPayload } from '@openestate/shared';
import { AuthzVersionService } from '../authz-version.service';

/**
 * Refuses an access token (staff or portal, including a 2FA-pending one) whose
 * `av` no longer equals the user's current authorisation version: the user was
 * deactivated, their role or its permissions changed, their password was
 * changed or reset, or their 2FA was reset since the token was issued. Without
 * this, such a token kept working until it expired (up to 15 minutes), because
 * the JWT check never looks at the database.
 *
 * A token with no `av` (issued before this check existed) is refused the same
 * way. The answer is 401, so the browser tries its refresh token: a session that
 * is still allowed gets a fresh token and carries on; one that is not (deactivated,
 * password changed elsewhere) lands on the sign-in page.
 *
 * Global, registered straight after TwoFactorPendingGuard. @Public routes have
 * no req.user and are untouched. Never fails open: if neither Redis nor the
 * database can be read, AuthzVersionService throws and the request fails.
 */
@Injectable()
export class SessionVersionGuard implements CanActivate {
  constructor(private readonly versions: AuthzVersionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const user = context.switchToHttp().getRequest().user as JwtPayload | undefined;
    if (!user) return true;
    if (typeof user.av !== 'number') throw new UnauthorizedException(SESSION_ENDED_MESSAGE);
    const current = await this.versions.current(user.sub);
    if (current === null) throw new UnauthorizedException(SESSION_ENDED_MESSAGE);
    if (user.av === current) return true;
    // Versions only go up, so a token newer than the cache means the cache is
    // behind (a bump made directly in the database, as the upgrade's
    // permission sync does). Ask the database, and accept only an exact match.
    // An older token is refused without a database read, as before.
    if (user.av > current && (await this.versions.fromDatabase(user.sub)) === user.av) return true;
    throw new UnauthorizedException(SESSION_ENDED_MESSAGE);
  }
}
