import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import {
  createUserSchema,
  updateUserSchema,
  sortableListQuerySchema,
  PERMISSIONS,
} from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { UsersService } from './users.service';
import { TeamScopeService } from '../team-scope/team-scope.service';

class CreateUserDto extends createZodDto(createUserSchema) {}
class UpdateUserDto extends createZodDto(updateUserSchema) {}
// Sortable only by the columns the list shows.
class PaginationQueryDto extends createZodDto(sortableListQuerySchema(['name', 'email'] as const)) {}

@ApiTags('Users')
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly teamScope: TeamScopeService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ADMIN_USER_READ)
  @ApiOperation({ summary: 'List users' })
  findAll(@Query() query: PaginationQueryDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.usersService.findAll(user.companyId, query);
  }

  /**
   * MUST stay declared ABOVE `@Get(':id')`. Nest registers a controller's
   * routes with Express in method-declaration order and Express matches
   * the first pattern that fits, so with the order reversed a request for
   * the literal path `/users/hierarchy` is swallowed as `id="hierarchy"`
   * and 404s. This is the exact hazard that bit `/inquiries/import-template`
   * (see CLAUDE.md v0.3.1) — the ordering here is load-bearing, not
   * cosmetic.
   */
  @Get('hierarchy')
  @RequirePermissions(PERMISSIONS.ADMIN_USER_READ)
  @ApiOperation({
    summary: "Read-only org tree, scoped to the caller's visible subtree (admins see the whole company)",
  })
  async hierarchy(@Req() req: Request) {
    const user = req.user as JwtPayload;
    const visibleUserIds = await this.teamScope.getVisibleUserIds(
      user.companyId,
      user.sub,
      user.permissions,
    );
    return this.usersService.getHierarchy(user.companyId, visibleUserIds);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_USER_READ)
  @ApiOperation({ summary: 'Get user by ID' })
  findOne(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.usersService.findOne(user.companyId, id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.ADMIN_USER_CREATE)
  @ApiOperation({ summary: 'Create user' })
  create(@Body() dto: CreateUserDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.usersService.create(user.companyId, dto, user.sub);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_USER_UPDATE)
  @ApiOperation({ summary: 'Update user' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @Req() req: Request,
  ) {
    const user = req.user as JwtPayload;
    return this.usersService.update(user.companyId, id, dto, user.sub);
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.ADMIN_USER_DEACTIVATE)
  @ApiOperation({ summary: 'Deactivate user (soft delete)' })
  deactivate(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.usersService.deactivate(user.companyId, id, user.sub);
  }

  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.ADMIN_USER_UPDATE)
  @ApiOperation({ summary: 'Reactivate user' })
  reactivate(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.usersService.reactivate(user.companyId, id, user.sub);
  }

  @Post(':id/force-password-reset')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.ADMIN_USER_UPDATE)
  @ApiOperation({
    summary: 'Issue a one-time password-reset link for a staff user',
    description:
      'Returns the raw reset token to the caller exactly once, for manual out-of-band delivery ' +
      '(WhatsApp, phone, in person) — it is stored only as a hash and cannot be retrieved again. ' +
      'Issuing a new token invalidates any outstanding one. Never sets or reveals a password. ' +
      'Portal users are rejected (400; they reset through the portal); deactivated users are rejected (409).',
  })
  @ApiOkResponse({
    description: '`{ token, expiresAt }` — the reset URL is `<staff app origin>/reset-password?token=<token>`.',
  })
  forcePasswordReset(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.usersService.forcePasswordReset(user.companyId, id, user.sub);
  }

  @Post(':id/reset-2fa')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PERMISSIONS.ADMIN_USER_UPDATE)
  @ApiOperation({
    summary: "Clear a staff user's two-factor authentication",
    description:
      'For a user who has lost both their authenticator and their recovery codes. Clears the ' +
      'TOTP secret, recovery codes and 2FA lockout, and revokes every refresh token; the password ' +
      'is unchanged. An access token already issued stays valid until it expires (up to 15 minutes ' +
      'by default). Audited as TOTP_RESET_BY_ADMIN, including when 2FA was already off. ' +
      'Deactivated users are allowed. 400 for a portal user or for your own account; 404 if not in your company.',
  })
  @ApiOkResponse({ description: '`{ wasEnabled }` — whether 2FA was on before the reset.' })
  resetTotp(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.usersService.resetTotp(user.companyId, id, user.sub);
  }
}
