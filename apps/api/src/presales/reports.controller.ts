import { Controller, Get, Post, Body, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { PERMISSIONS, reportDateRangeSchema } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { ReportsService, type ReportScope, type DateRange } from './reports.service';
import { TeamScopeService } from '../team-scope/team-scope.service';
import { toCsv } from './csv.util';
import { streamCsv } from '../reports/csv-stream.util';
import { maskColumn, requireExport } from '../reports/export-gate';

// Exported at module scope (not just used inline) because a controller-
// method-direct-call test bypasses Nest's validation pipe entirely — only
// a schema-level `.safeParse()` test actually proves a `.strict()` DTO
// rejects what it should (Phase 5's soldUnits lesson, CLAUDE.md).
export const reportQuerySchema = reportDateRangeSchema;
export const reportQueryWithExecutiveSchema = reportDateRangeSchema.extend({
  executiveId: z.string().uuid().optional(),
});
export const reportFormatOnlySchema = z.object({ format: z.enum(['json', 'csv']).default('json') }).strict();
export const auditPrintSchema = z
  .object({
    reportKey: z.string().min(1).max(100),
    filters: z.record(z.unknown()).default({}),
    rowCount: z.number().int().min(0),
  })
  .strict();

class ReportQueryDto extends createZodDto(reportQuerySchema) {}
class ReportQueryWithExecutiveDto extends createZodDto(reportQueryWithExecutiveSchema) {}
class ReportFormatOnlyDto extends createZodDto(reportFormatOnlySchema) {}
class AuditPrintDto extends createZodDto(auditPrintSchema) {}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}


@ApiTags('Presales Reports')
@Controller('reports/presales')
export class ReportsController {
  constructor(
    private readonly reportsService: ReportsService,
    private readonly teamScope: TeamScopeService,
  ) {}

  private async scopeFor(user: JwtPayload): Promise<ReportScope> {
    const visibleUserIds = await this.teamScope.getVisibleUserIds(
      user.companyId,
      user.sub,
      user.permissions,
    );
    return { visibleUserIds };
  }

  /**
   * Buffered aggregate-report responder: `format=csv` requires
   * `presales.report.export` (separate from `.view`) and writes an audit
   * row BEFORE the response is sent — same ordering the streamed routes
   * use, just with the row count already on hand from the array length.
   */
  private async respond(
    user: JwtPayload,
    req: Request,
    res: Response,
    format: string | undefined,
    reportKey: string,
    filters: object,
    rows: Array<Record<string, unknown>>,
  ): Promise<void> {
    if (format === 'csv') {
      requireExport(user);
      await this.reportsService.auditReportAction(user.companyId, user.sub, reportKey, 'EXPORT', filters, rows.length, req.ip);
      res.set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${reportKey}.csv"`,
      });
      res.send(toCsv(rows));
      return;
    }
    res.json(rows);
  }

  private async streamRespond(
    user: JwtPayload,
    req: Request,
    res: Response,
    reportKey: string,
    filters: object,
    headers: string[],
    rowCount: number,
    rows: AsyncGenerator<unknown[]>,
  ): Promise<void> {
    requireExport(user);
    await this.reportsService.auditReportAction(user.companyId, user.sub, reportKey, 'EXPORT', filters, rowCount, req.ip);
    await streamCsv(res, `${reportKey}.csv`, headers, rows);
  }

  private range(q: { from?: Date; to?: Date }): DateRange {
    return { from: q.from, to: q.to };
  }

  // ── existing reports ────────────────────────────────────────────

  @Get('daily-inquiries')
  @RequirePermissions(PERMISSIONS.PRESALES_REPORT_VIEW)
  @ApiOperation({ summary: 'Daily inquiries, staff-wise' })
  async dailyInquiries(@Query() q: ReportQueryDto, @Req() req: Request, @Res() res: Response) {
    const user = req.user as JwtPayload;
    const rows = await this.reportsService.dailyInquiriesStaffWise(user.companyId, await this.scopeFor(user), this.range(q), q.projectId);
    await this.respond(user, req, res, q.format, 'daily-inquiries', q, rows);
  }

  @Get('funnel')
  @RequirePermissions(PERMISSIONS.PRESALES_REPORT_VIEW)
  @ApiOperation({ summary: 'Funnel by status' })
  async funnel(@Query() q: ReportQueryDto, @Req() req: Request, @Res() res: Response) {
    const user = req.user as JwtPayload;
    const rows = await this.reportsService.funnelByStatus(user.companyId, await this.scopeFor(user), this.range(q), q.projectId);
    await this.respond(user, req, res, q.format, 'funnel', q, rows);
  }

  @Get('source-wise')
  @RequirePermissions(PERMISSIONS.PRESALES_REPORT_VIEW)
  @ApiOperation({ summary: 'Source-wise inquiry count with conversion % (status-based AND booking-linked, side by side)' })
  async sourceWise(@Query() q: ReportQueryDto, @Req() req: Request, @Res() res: Response) {
    const user = req.user as JwtPayload;
    const rows = await this.reportsService.sourceWiseConversion(user.companyId, await this.scopeFor(user), this.range(q), q.projectId);
    await this.respond(user, req, res, q.format, 'source-wise', q, rows);
  }

  @Get('budget-band')
  @RequirePermissions(PERMISSIONS.PRESALES_REPORT_VIEW)
  @ApiOperation({ summary: 'Budget-band analysis' })
  async budgetBand(@Query() q: ReportQueryDto, @Req() req: Request, @Res() res: Response) {
    const user = req.user as JwtPayload;
    const rows = await this.reportsService.budgetBandAnalysis(user.companyId, await this.scopeFor(user), this.range(q), q.projectId);
    await this.respond(user, req, res, q.format, 'budget-band', q, rows);
  }

  @Get('ageing')
  @RequirePermissions(PERMISSIONS.PRESALES_REPORT_VIEW)
  @ApiOperation({ summary: 'Ageing buckets (0-7 / 8-30 / 31-90 / 90+) for open inquiries' })
  async ageing(@Query() q: ReportQueryDto, @Req() req: Request, @Res() res: Response) {
    const user = req.user as JwtPayload;
    const rows = await this.reportsService.ageingBuckets(user.companyId, await this.scopeFor(user), this.range(q), q.projectId);
    await this.respond(user, req, res, q.format, 'ageing', q, rows);
  }

  @Get('staff-performance')
  @RequirePermissions(PERMISSIONS.PRESALES_REPORT_VIEW)
  @ApiOperation({ summary: 'Staff performance (assigned / successful / conversion %, status-based AND booking-linked)' })
  async staffPerformance(@Query() q: ReportQueryDto, @Req() req: Request, @Res() res: Response) {
    const user = req.user as JwtPayload;
    const rows = await this.reportsService.staffPerformance(user.companyId, await this.scopeFor(user), this.range(q), q.projectId);
    await this.respond(user, req, res, q.format, 'staff-performance', q, rows);
  }

  @Get('manager-wise')
  @RequirePermissions(PERMISSIONS.PRESALES_REPORT_VIEW)
  @ApiOperation({ summary: 'Manager-wise interaction counts (real team roll-up via TeamScopeService)' })
  async managerWise(@Query() q: ReportQueryDto, @Req() req: Request, @Res() res: Response) {
    const user = req.user as JwtPayload;
    const rows = await this.reportsService.managerWiseInteractions(user.companyId, await this.scopeFor(user), this.range(q));
    await this.respond(user, req, res, q.format, 'manager-wise', q, rows);
  }

  @Get('inquiries-export')
  @RequirePermissions(PERMISSIONS.PRESALES_REPORT_VIEW)
  @ApiOperation({ summary: 'Per-inquiry export, including a column per active custom field (streamed CSV supported)' })
  async inquiriesExport(@Query() q: ReportQueryDto, @Req() req: Request, @Res() res: Response) {
    const user = req.user as JwtPayload;
    const scope = await this.scopeFor(user);
    const { headers, definitions } = await this.reportsService.inquiriesExportHeaders(user.companyId);
    const gen = this.reportsService.inquiriesExport(user.companyId, scope, this.range(q), q.projectId, definitions);
    if (q.format === 'csv') {
      const rowCount = await this.reportsService.inquiriesExportCount(user.companyId, scope, this.range(q), q.projectId);
      return this.streamRespond(user, req, res, 'inquiries-export', q, headers, rowCount, gen);
    }
    // On screen it is a list view: the phone column is masked. The CSV
    // above (export permission, audited) keeps the full number.
    res.json(maskColumn(await collect(gen), headers.indexOf('Applicant Phone')));
  }

  // ── new reports ─────────────────────────────────────────────────

  @Get('leads-by-stage')
  @RequirePermissions(PERMISSIONS.PRESALES_REPORT_VIEW)
  @ApiOperation({ summary: 'Leads by pipeline stage' })
  async leadsByStage(@Query() q: ReportQueryDto, @Req() req: Request, @Res() res: Response) {
    const user = req.user as JwtPayload;
    const rows = await this.reportsService.leadsByStage(user.companyId, await this.scopeFor(user), this.range(q), q.projectId);
    await this.respond(user, req, res, q.format, 'leads-by-stage', q, rows);
  }

  @Get('enquiry-type')
  @RequirePermissions(PERMISSIONS.PRESALES_REPORT_VIEW)
  @ApiOperation({ summary: 'Enquiry-type breakdown (Fresh/Resale/Rental/Commercial) — not to be confused with source-wise' })
  async enquiryType(@Query() q: ReportQueryDto, @Req() req: Request, @Res() res: Response) {
    const user = req.user as JwtPayload;
    const rows = await this.reportsService.enquiryTypeReport(user.companyId, await this.scopeFor(user), this.range(q), q.projectId);
    await this.respond(user, req, res, q.format, 'enquiry-type', q, rows);
  }

  @Get('dump-report')
  @RequirePermissions(PERMISSIONS.PRESALES_REPORT_VIEW)
  @ApiOperation({ summary: 'Dump report — by reason, by executive, over time (streamed CSV supported)' })
  async dumpReport(@Query() q: ReportQueryWithExecutiveDto, @Req() req: Request, @Res() res: Response) {
    const user = req.user as JwtPayload;
    const scope = await this.scopeFor(user);
    const range = this.range(q);
    const headers = ['Date', 'Applicant', 'Executive', 'Reason', 'Remarks'];
    const gen = this.reportsService.dumpReport(user.companyId, scope, range, q.executiveId);
    if (q.format === 'csv') {
      const rowCount = await this.reportsService.dumpReportCount(user.companyId, scope, range, q.executiveId);
      return this.streamRespond(user, req, res, 'dump-report', q, headers, rowCount, gen);
    }
    res.json(await collect(gen));
  }

  @Get('site-visit')
  @RequirePermissions(PERMISSIONS.PRESALES_REPORT_VIEW)
  @ApiOperation({ summary: 'Site visit report (streamed CSV supported)' })
  async siteVisit(@Query() q: ReportQueryWithExecutiveDto, @Req() req: Request, @Res() res: Response) {
    const user = req.user as JwtPayload;
    const scope = await this.scopeFor(user);
    const range = this.range(q);
    const headers = ['Date', 'Executive', 'Applicant', 'Project', 'Venue', 'Outcome'];
    const gen = this.reportsService.siteVisitReport(user.companyId, scope, range, q.executiveId);
    if (q.format === 'csv') {
      const rowCount = await this.reportsService.siteVisitReportCount(user.companyId, scope, range, q.executiveId);
      return this.streamRespond(user, req, res, 'site-visit', q, headers, rowCount, gen);
    }
    res.json(await collect(gen));
  }

  @Get('stage-transitions')
  @RequirePermissions(PERMISSIONS.PRESALES_REPORT_VIEW)
  @ApiOperation({ summary: 'Stage transition matrix (excludes administrative bulk-reassignment moves)' })
  async stageTransitions(@Query() q: ReportQueryDto, @Req() req: Request, @Res() res: Response) {
    const user = req.user as JwtPayload;
    const rows = await this.reportsService.stageTransitions(user.companyId, await this.scopeFor(user), this.range(q));
    await this.respond(user, req, res, q.format, 'stage-transitions', q, rows);
  }

  @Get('stage-velocity')
  @RequirePermissions(PERMISSIONS.PRESALES_REPORT_VIEW)
  @ApiOperation({ summary: 'Average days spent per stage (closed stays only)' })
  async stageVelocity(@Query() q: ReportQueryDto, @Req() req: Request, @Res() res: Response) {
    const user = req.user as JwtPayload;
    const rows = await this.reportsService.stageVelocity(user.companyId, await this.scopeFor(user), this.range(q));
    await this.respond(user, req, res, q.format, 'stage-velocity', q, rows);
  }

  @Get('follow-up-overdue')
  @RequirePermissions(PERMISSIONS.PRESALES_REPORT_VIEW)
  @ApiOperation({ summary: 'Overdue follow-up count per executive (live gauge — ignores date range)' })
  async followUpOverdue(@Query() q: ReportFormatOnlyDto, @Req() req: Request, @Res() res: Response) {
    const user = req.user as JwtPayload;
    const rows = await this.reportsService.followUpOverdue(user.companyId, await this.scopeFor(user));
    await this.respond(user, req, res, q.format, 'follow-up-overdue', {}, rows);
  }

  @Get('follow-up-delay')
  @RequirePermissions(PERMISSIONS.PRESALES_REPORT_VIEW)
  @ApiOperation({ summary: 'Average delay between a follow-up’s next-action date and the follow-up that closed it, per executive' })
  async followUpDelay(@Query() q: ReportQueryDto, @Req() req: Request, @Res() res: Response) {
    const user = req.user as JwtPayload;
    const rows = await this.reportsService.followUpDelay(user.companyId, await this.scopeFor(user), this.range(q));
    await this.respond(user, req, res, q.format, 'follow-up-delay', q, rows);
  }

  @Get('supervisor-review-queue')
  @RequirePermissions(PERMISSIONS.PRESALES_REPORT_VIEW)
  @ApiOperation({ summary: 'Dumped + transferred leads for the SOP-mandated weekly supervisor review (streamed CSV supported)' })
  async supervisorReviewQueue(@Query() q: ReportQueryWithExecutiveDto, @Req() req: Request, @Res() res: Response) {
    const user = req.user as JwtPayload;
    const scope = await this.scopeFor(user);
    const range = this.range(q);
    const headers = ['Date', 'Type', 'Applicant', 'From / Changed By', 'To', 'Reason'];
    const gen = this.reportsService.supervisorReviewQueue(user.companyId, scope, range, q.executiveId);
    if (q.format === 'csv') {
      const rowCount = await this.reportsService.supervisorReviewQueueCount(user.companyId, scope, range, q.executiveId);
      return this.streamRespond(user, req, res, 'supervisor-review-queue', q, headers, rowCount, gen);
    }
    res.json(await collect(gen));
  }

  @Get('daily-work')
  @RequirePermissions(PERMISSIONS.PRESALES_REPORT_VIEW)
  @ApiOperation({ summary: 'Daily work report — per-user activity for a date range' })
  async dailyWork(@Query() q: ReportQueryDto, @Req() req: Request, @Res() res: Response) {
    const user = req.user as JwtPayload;
    const rows = await this.reportsService.dailyWorkReport(user.companyId, await this.scopeFor(user), this.range(q));
    await this.respond(user, req, res, q.format, 'daily-work', q, rows);
  }

  @Get('communication-type')
  @RequirePermissions(PERMISSIONS.PRESALES_REPORT_VIEW)
  @ApiOperation({ summary: 'Communication-type breakdown (FollowUpType) with booking-linked conversion %' })
  async communicationType(@Query() q: ReportQueryDto, @Req() req: Request, @Res() res: Response) {
    const user = req.user as JwtPayload;
    const rows = await this.reportsService.communicationTypeBreakdown(user.companyId, await this.scopeFor(user), this.range(q));
    await this.respond(user, req, res, q.format, 'communication-type', q, rows);
  }

  // ── print audit ─────────────────────────────────────────────────

  @Post('audit-action')
  @RequirePermissions(PERMISSIONS.PRESALES_REPORT_PRINT)
  @ApiOperation({ summary: 'Records a print action on the audit log — call before window.print()' })
  async auditPrint(@Body() body: AuditPrintDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    await this.reportsService.auditReportAction(
      user.companyId,
      user.sub,
      body.reportKey,
      'PRINT',
      body.filters,
      body.rowCount,
      req.ip,
    );
    return { ok: true };
  }
}
