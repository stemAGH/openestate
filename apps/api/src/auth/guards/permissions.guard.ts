import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { JwtPayload } from '@openestate/shared';

export const PERMISSIONS_KEY = 'requiredPermissions';

export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

export const ANY_PERMISSIONS_KEY = 'anyOfPermissions';

/** The caller needs at least one of these (on top of any RequirePermissions). */
export const RequireAnyPermission = (...permissions: string[]) =>
  SetMetadata(ANY_PERMISSIONS_KEY, permissions);

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    const anyOf = this.reflector.getAllAndOverride<string[] | undefined>(
      ANY_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if ((!required || required.length === 0) && (!anyOf || anyOf.length === 0)) return true;

    const request = context.switchToHttp().getRequest();
    const user = request.user as JwtPayload | undefined;
    if (!user) return false;

    const userPerms = new Set(user.permissions);
    const hasAll = (required ?? []).every((p) => userPerms.has(p));
    const hasAny = !anyOf || anyOf.length === 0 || anyOf.some((p) => userPerms.has(p));
    if (!hasAll || !hasAny) {
      throw new ForbiddenException('Insufficient permissions');
    }
    return true;
  }
}
