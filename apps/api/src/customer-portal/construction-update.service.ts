import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import * as fs from 'node:fs';
import { withTenantTx, type PrismaClient } from '@openestate/db';
import { NOTIFICATION_EVENT, type CreateConstructionUpdateDto } from '@openestate/shared';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';
import { assertOwnedByCompany } from '../common/tenant-ownership';
import { UploadService } from '../inventory/upload.service';
import { assertProjectMediaCapacity } from '../inventory/project-media-limits';
import { NotificationService } from '../notifications/notification.service';

@Injectable()
export class ConstructionUpdateService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
    private readonly uploadService: UploadService,
    private readonly notifications: NotificationService,
  ) {}

  async create(companyId: string, createdById: string, dto: CreateConstructionUpdateDto) {
    const update = await withTenantTx(this.tenantPrisma, companyId, async (tx) => {
      await assertOwnedByCompany(tx, companyId, [['project', dto.projectId, 'Project']]);
      return tx.constructionUpdate.create({
        data: {
          companyId,
          projectId: dto.projectId,
          title: dto.title,
          description: dto.description,
          publishedAt: dto.publishedAt,
          createdById,
        },
      });
    });

    // Fired AFTER the transaction commits. Primary applicants only —
    // matches the sole notification-audience convention already used
    // everywhere else in this codebase (DocumentService's letters,
    // DispatchService); co-applicant expansion is new scope, not a
    // precedent, and stays out of this trigger.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bookings: any[] = await this.systemPrisma.booking.findMany({
      // Unit.projectId (Phase A scalar) — the old floor.tower.projectId
      // traversal silently sent zero notifications for a LAND_BASED
      // project's bookings. See plotted-farmhouse-inventory.md §13.1.
      where: { companyId, unit: { projectId: dto.projectId } },
      select: { primaryApplicantId: true },
    });
    const applicantIds = [...new Set(bookings.map((b) => b.primaryApplicantId as string))];
    for (const applicantId of applicantIds) {
      await this.notifications.notify(
        companyId,
        NOTIFICATION_EVENT.CONSTRUCTION_UPDATE_PUBLISHED,
        { applicantId },
        `New update: ${update.title}`,
        update.description ?? update.title,
      );
    }

    return update;
  }

  async addMedia(companyId: string, updateId: string, file: { buffer: Buffer; originalname: string; size: number }) {
    return withTenantTx(this.tenantPrisma, companyId, async (tx) => {
      const update = await tx.constructionUpdate.findFirst({ where: { id: updateId } });
      if (!update) throw new NotFoundException('Construction update not found');

      await assertProjectMediaCapacity(tx, companyId, update.projectId, file.size);

      const uploaded = await this.uploadService.validateAndStore(file, 'construction_progress');
      const count = await tx.constructionUpdateMedia.count({ where: { constructionUpdateId: updateId } });

      return tx.constructionUpdateMedia.create({
        data: {
          companyId,
          constructionUpdateId: updateId,
          storedName: uploaded.storageName,
          originalName: uploaded.originalName,
          mimeType: uploaded.mimeType,
          sizeBytes: uploaded.size,
          sortOrder: count,
        },
      });
    });
  }

  async listForProject(companyId: string, projectId: string) {
    return withTenantTx(this.tenantPrisma, companyId, (tx) =>
      tx.constructionUpdate.findMany({
        where: { projectId },
        include: { media: { orderBy: { sortOrder: 'asc' } } },
        orderBy: { publishedAt: 'desc' },
      }),
    );
  }

  /**
   * DB rows only — matches ProjectMediaService.remove()'s existing
   * precedent of not cleaning up the physical file from disk. Media rows
   * cascade via the schema's onDelete: Cascade.
   */
  async remove(companyId: string, id: string) {
    return withTenantTx(this.tenantPrisma, companyId, async (tx) => {
      const update = await tx.constructionUpdate.findFirst({ where: { id } });
      if (!update) throw new NotFoundException('Construction update not found');
      await tx.constructionUpdate.delete({ where: { id } });
      return { id };
    });
  }

  /** Staff download — direct company-scoped lookup, same shape as DocumentService.getDocumentBytes. */
  async getMediaBytes(companyId: string, mediaId: string): Promise<{ buffer: Buffer; mimeType: string; originalName: string }> {
    const media = await this.systemPrisma.constructionUpdateMedia.findFirst({ where: { id: mediaId, companyId } });
    if (!media) throw new NotFoundException('Media not found');
    const filePath = this.uploadService.pathFor('construction_progress', media.storedName);
    const buffer = await fs.promises.readFile(filePath);
    return { buffer, mimeType: media.mimeType, originalName: media.originalName };
  }

  /**
   * Portal counterpart to getMediaBytes() — RLS
   * (construction_update_media_portal_scope) is the sole enforcement,
   * same "RLS is the primary IDOR defense" discipline as
   * DocumentService.getDocumentBytesForPortal.
   */
  async getMediaBytesForPortal(companyId: string, mediaId: string): Promise<{ buffer: Buffer; mimeType: string; originalName: string }> {
    const media = await withTenantTx(this.tenantPrisma, companyId, (tx) =>
      tx.constructionUpdateMedia.findFirst({ where: { id: mediaId } }),
    );
    if (!media) throw new NotFoundException('Media not found');
    const filePath = this.uploadService.pathFor('construction_progress', media.storedName);
    const buffer = await fs.promises.readFile(filePath);
    return { buffer, mimeType: media.mimeType, originalName: media.originalName };
  }
}
