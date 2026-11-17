import { ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { PrismaClient, withTenantTx, runWithTenant, getCurrentIpAddress } from '@openestate/db';
import { maskPhone, normalizeEmail, normalizePhone, PERMISSIONS, type JwtPayload, type UpdateApplicantDto } from '@openestate/shared';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';
import { TokenService } from '../auth/token.service';
import { AuthzVersionService } from '../auth/authz-version.service';
import { ApplicantService } from './applicant.service';

const maskEmail = (e: string | null) => (e ? `${e.charAt(0)}***@${e.split('@')[1] ?? ''}` : null);

/**
 * Staff edits to an applicant's contact details (PATCH /applicants/:id).
 *
 * - A phone or email that another person already has is refused (409, the
 *   matches listed, phones masked) unless the caller confirms they are
 *   different people, which is recorded as on creation. Never merges.
 * - If the customer has a portal account that signs in with the phone or
 *   email being changed, the change needs admin.user.update; the portal
 *   login moves to the new value, the account's sessions end, and a
 *   PORTAL_LOGIN_CHANGED audit row records it with masked values. (The login
 *   is updated with updateMany so the generic UPDATE audit row, which would
 *   hold the full numbers, is replaced by that masked row.)
 * Everything else goes through ApplicantService.update unchanged.
 */
@Injectable()
export class ApplicantContactService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
    private readonly applicants: ApplicantService,
    private readonly tokens: TokenService,
    private readonly authzVersions: AuthzVersionService,
  ) {}

  async update(user: JwtPayload, id: string, dto: UpdateApplicantDto & { confirmDistinct?: boolean }) {
    const companyId = user.companyId;
    const { confirmDistinct, ...input } = dto;
    const existing = await this.applicants.findOne(companyId, id);

    const newPhone = input.primaryPhone !== undefined ? normalizePhone(input.primaryPhone) : existing.primaryPhoneNormalized;
    const newEmail = input.email !== undefined ? (input.email ? normalizeEmail(input.email) : null) : existing.emailNormalized;
    const phoneChanged = newPhone !== existing.primaryPhoneNormalized;
    const emailChanged = newEmail !== existing.emailNormalized;

    if (phoneChanged || emailChanged) {
      const others = (await this.applicants.findDuplicates(companyId, newPhone, newEmail, id)).filter(
        (d: { id: string; primaryPhoneNormalized: string; emailNormalized: string | null }) =>
          d.id !== id && ((phoneChanged && d.primaryPhoneNormalized === newPhone) || (emailChanged && !!newEmail && d.emailNormalized === newEmail)),
      );
      if (others.length && !confirmDistinct) {
        throw new ConflictException({
          statusCode: 409,
          message: 'Another person already has this phone or email. Check it is a different person, then confirm to save.',
          duplicates: others.map((d: { id: string; name: string; primaryPhone: string }) => ({ id: d.id, name: d.name, primaryPhone: maskPhone(d.primaryPhone) })),
        });
      }
      for (const d of others) await this.applicants.confirmDistinct(companyId, id, d.id, user.sub);
    }

    // Portal accounts that sign in with the value being changed.
    const portalUsers: Array<{ id: string; phone: string | null; email: string | null }> = await this.systemPrisma.user.findMany({
      where: { companyId, applicantId: id, role: { isPortal: true } },
      select: { id: true, phone: true, email: true },
    });
    const moves = portalUsers
      .map((u) => ({
        user: u,
        phone: phoneChanged && !!u.phone && normalizePhone(u.phone) === existing.primaryPhoneNormalized,
        email: emailChanged && !!u.email && normalizeEmail(u.email) === existing.emailNormalized,
      }))
      .filter((m) => m.phone || m.email);
    if (moves.length && !user.permissions.includes(PERMISSIONS.ADMIN_USER_UPDATE)) {
      throw new ForbiddenException(
        'This customer signs in to the portal with this phone or email; changing it needs the admin.user.update permission.',
      );
    }
    if (moves.some((m) => m.email) && newEmail) {
      const taken = await this.systemPrisma.user.findFirst({
        where: { companyId, email: input.email, id: { notIn: moves.map((m) => m.user.id) } },
        select: { id: true },
      });
      if (taken) throw new ConflictException('Another account already signs in with this email.');
    }

    const updated = await this.applicants.update(companyId, id, input);

    if (moves.length) {
      await runWithTenant({ companyId }, () =>
        withTenantTx(this.tenantPrisma, companyId, async (tx) => {
          for (const m of moves) {
            await tx.user.updateMany({
              where: { id: m.user.id, companyId },
              data: { ...(m.phone ? { phone: input.primaryPhone!.trim() } : {}), ...(m.email ? { email: input.email } : {}) },
            });
            await tx.auditLog.create({
              data: {
                companyId,
                userId: user.sub,
                entityType: 'User',
                entityId: m.user.id,
                action: 'PORTAL_LOGIN_CHANGED',
                after: {
                  applicantId: id,
                  field: [m.phone && 'phone', m.email && 'email'].filter(Boolean).join(','),
                  ...(m.phone ? { phoneFrom: maskPhone(m.user.phone), phoneTo: maskPhone(input.primaryPhone!.trim()) } : {}),
                  ...(m.email ? { emailFrom: maskEmail(m.user.email), emailTo: maskEmail(input.email ?? null) } : {}),
                  sessionsEnded: true,
                },
                ipAddress: getCurrentIpAddress() ?? null,
              },
            });
          }
        }),
      );
      // After the commit, as UsersService does: every token issued before now is refused.
      for (const m of moves) await this.authzVersions.publish(m.user.id, await this.tokens.endSessions(m.user.id));
    }
    return updated;
  }
}
