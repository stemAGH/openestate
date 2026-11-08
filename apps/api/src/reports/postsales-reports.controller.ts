import { Controller, Get, Inject, Param, Query, Req, Res } from '@nestjs/common';
import { PrismaClient } from '@openestate/db';
import { SYSTEM_PRISMA } from '../database/database.module';
import { auditExport, maskColumn, requireExport } from './export-gate';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { reportDateRangeSchema, PERMISSIONS } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { PostsalesReportsService, type ReportScope } from './postsales-reports.service';
import { TeamScopeService } from '../team-scope/team-scope.service';
import { streamCsv } from './csv-stream.util';
import { toCsv } from '../presales/csv.util';

class ReportQueryDto extends createZodDto(reportDateRangeSchema) {}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

@ApiTags('Postsales Reports')
@Controller('reports/postsales')
export class PostsalesReportsController {
  constructor(
    private readonly reports: PostsalesReportsService,
    private readonly teamScope: TeamScopeService,
    @Inject(SYSTEM_PRISMA) private readonly prisma: PrismaClient,
  ) {}

  private async scopeFor(user: JwtPayload): Promise<ReportScope> {
    const visibleUserIds = await this.teamScope.getVisibleUserIds(
      user.companyId,
      user.sub,
      user.permissions,
    );
    return { visibleUserIds };
  }

  @Get('installment-dues')
  @RequirePermissions(PERMISSIONS.REPORTS_OUTSTANDING_VIEW)
  @ApiOperation({ summary: 'Installment-wise dues (streamed CSV supported)' })
  async installmentDues(@Query() q: ReportQueryDto, @Req() req: Request, @Res() res: Response) {
    const u = req.user as JwtPayload;
    const headers = ['Booking No.', 'Applicant', 'Installment', 'Due Date', 'Outstanding', 'Overdue Days'];
    const gen = this.reports.installmentDues(u.companyId, await this.scopeFor(u), q.projectId, false);
    if (q.format === 'csv') return streamCsv(res, 'installment-dues.csv', headers, gen);
    res.json(await collect(gen));
  }

  @Get('installment-dues-with-interest')
  @RequirePermissions(PERMISSIONS.REPORTS_OUTSTANDING_VIEW)
  @ApiOperation({ summary: 'Installment-wise dues including accrued interest (streamed CSV supported)' })
  async installmentDuesWithInterest(@Query() q: ReportQueryDto, @Req() req: Request, @Res() res: Response) {
    const u = req.user as JwtPayload;
    const headers = ['Booking No.', 'Applicant', 'Installment', 'Due Date', 'Outstanding', 'Overdue Days', 'Accrued Interest'];
    const gen = this.reports.installmentDues(u.companyId, await this.scopeFor(u), q.projectId, true);
    if (q.format === 'csv') return streamCsv(res, 'installment-dues-interest.csv', headers, gen);
    res.json(await collect(gen));
  }

  @Get('dues-ageing')
  @RequirePermissions(PERMISSIONS.REPORTS_OUTSTANDING_VIEW)
  @ApiOperation({ summary: 'Overdue-installment ageing buckets (0-7/8-30/31-90/90+)' })
  async duesAgeing(@Query() q: ReportQueryDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.reports.duesAgeing(u.companyId, await this.scopeFor(u), q.projectId);
  }

  @Get('collection/detail')
  @RequirePermissions(PERMISSIONS.REPORTS_COLLECTION_VIEW)
  @ApiOperation({ summary: 'Collection detail — one row per receipt (streamed CSV supported)' })
  async collectionDetail(@Query() q: ReportQueryDto, @Req() req: Request, @Res() res: Response) {
    const u = req.user as JwtPayload;
    const headers = ['Receipt No.', 'Date', 'Booking No.', 'Applicant', 'Mode', 'Amount'];
    const gen = this.reports.collectionDetail(u.companyId, await this.scopeFor(u), q.from, q.to, q.projectId);
    if (q.format === 'csv') return streamCsv(res, 'collection-detail.csv', headers, gen);
    res.json(await collect(gen));
  }

  @Get('collection/summary')
  @RequirePermissions(PERMISSIONS.REPORTS_COLLECTION_VIEW)
  @ApiOperation({ summary: 'Collection summary (count + total)' })
  async collectionSummary(@Query() q: ReportQueryDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.reports.collectionSummary(u.companyId, await this.scopeFor(u), q.from, q.to, q.projectId);
  }

  @Get('collection/daily')
  @RequirePermissions(PERMISSIONS.REPORTS_COLLECTION_VIEW)
  @ApiOperation({ summary: 'Collection grouped by day' })
  async collectionDaily(@Query() q: ReportQueryDto, @Req() req: Request, @Res() res: Response) {
    const u = req.user as JwtPayload;
    const headers = ['Date', 'Total'];
    const gen = this.reports.collectionByPeriod(u.companyId, await this.scopeFor(u), 'daily', q.from, q.to, q.projectId);
    if (q.format === 'csv') return streamCsv(res, 'collection-daily.csv', headers, gen);
    res.json(await collect(gen));
  }

  @Get('collection/monthly')
  @RequirePermissions(PERMISSIONS.REPORTS_COLLECTION_VIEW)
  @ApiOperation({ summary: 'Collection grouped by month' })
  async collectionMonthly(@Query() q: ReportQueryDto, @Req() req: Request, @Res() res: Response) {
    const u = req.user as JwtPayload;
    const headers = ['Month', 'Total'];
    const gen = this.reports.collectionByPeriod(u.companyId, await this.scopeFor(u), 'monthly', q.from, q.to, q.projectId);
    if (q.format === 'csv') return streamCsv(res, 'collection-monthly.csv', headers, gen);
    res.json(await collect(gen));
  }

  @Get('applicant-ledger/:bookingId')
  @RequirePermissions(PERMISSIONS.REPORTS_APPLICANT_LEDGER_VIEW)
  @ApiOperation({ summary: 'Applicant ledger for a booking (reconciles exactly to the service balance)' })
  async applicantLedger(
    @Param('bookingId') bookingId: string,
    @Query() q: ReportQueryDto,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const u = req.user as JwtPayload;
    const result = await this.reports.applicantLedger(u.companyId, bookingId, await this.scopeFor(u));
    if (q.format === 'csv') {
      const headers = ['Date', 'Type', 'Reason', 'Signed Amount (paise)', 'Running Balance (paise)'];
      async function* rows(): AsyncGenerator<unknown[]> {
        for (const e of result.entries) {
          yield [e.effectiveDate, e.entryType, e.reason ?? '', e.signedAmountPaise, e.runningBalancePaise];
        }
      }
      return streamCsv(res, `applicant-ledger-${bookingId}.csv`, headers, rows());
    }
    res.json(result);
  }

  @Get('units/status-rollup')
  @RequirePermissions(PERMISSIONS.REPORTS_SALES_VIEW)
  @ApiOperation({ summary: 'Unit status rollup (sold vs available etc.)' })
  async unitStatusRollup(@Query() q: ReportQueryDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.reports.unitStatusRollup(u.companyId, q.projectId);
  }

  @Get('bookings/status-rollup')
  @RequirePermissions(PERMISSIONS.REPORTS_SALES_VIEW)
  @ApiOperation({ summary: 'Booking status rollup (registered vs allotted etc.)' })
  async bookingStatusRollup(@Query() q: ReportQueryDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.reports.bookingStatusRollup(u.companyId, q.projectId);
  }

  @Get('project-rollup')
  @RequirePermissions(PERMISSIONS.REPORTS_SALES_VIEW)
  @ApiOperation({ summary: 'Project-wise rollup (units, bookings, collection)' })
  async projectRollup(@Req() req: Request, @Res() res: Response, @Query('format') format?: string) {
    const u = req.user as JwtPayload;
    const rows = await this.reports.projectRollup(u.companyId);
    if (format === 'csv') {
      res.set({ 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="project-rollup.csv"' });
      return res.send(toCsv(rows));
    }
    res.json(rows);
  }

  @Get('company-rollup')
  @RequirePermissions(PERMISSIONS.REPORTS_SALES_VIEW)
  @ApiOperation({ summary: 'Company-wide rollup' })
  async companyRollup(@Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.reports.companyRollup(u.companyId);
  }

  @Get('zero-gst-bookings-count')
  @RequirePermissions(PERMISSIONS.REPORTS_SALES_VIEW)
  @ApiOperation({ summary: 'Count of bookings whose base cost line has no GST rate (pre-dates the rate picker)' })
  async zeroGstBookingsCount(@Req() req: Request) {
    const u = req.user as JwtPayload;
    return { count: await this.reports.zeroGstBaseBookingsCount(u.companyId) };
  }

  @Get('zero-gst-bookings')
  @RequirePermissions(PERMISSIONS.REPORTS_SALES_VIEW)
  @ApiOperation({ summary: 'Bookings whose base cost line has no GST rate (streamed CSV supported)' })
  async zeroGstBookings(@Query('format') format: string | undefined, @Req() req: Request, @Res() res: Response) {
    const u = req.user as JwtPayload;
    const headers = ['Booking No.', 'Applicant', 'Unit', 'Booking Date'];
    const gen = this.reports.zeroGstBaseBookings(u.companyId);
    if (format === 'csv') return streamCsv(res, 'zero-gst-bookings.csv', headers, gen);
    res.json(await collect(gen));
  }

  @Get('birthday-list')
  @RequirePermissions(PERMISSIONS.REPORTS_BIRTHDAY_VIEW)
  @ApiOperation({ summary: 'Applicants with a birthday within N days (default 30)' })
  async birthdayList(
    @Query('withinDays') withinDays: string | undefined,
    @Query('format') format: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const u = req.user as JwtPayload;
    const days = withinDays ? Number(withinDays) : 30;
    const headers = ['Name', 'Phone', 'Birthday (MM-DD)', 'Days Away'];
    if (format === 'csv') requireExport(u); // before any query runs
    const rows = await collect(this.reports.birthdayList(u.companyId, days));
    if (format === 'csv') {
      // Full numbers leave the system: export permission (above) and an audit row.
      await auditExport(this.prisma, { user: u, entityType: 'PostsalesReport', reportKey: 'birthday-list', filters: { withinDays: days }, rowCount: rows.length, ip: req.ip });
      return streamCsv(res, 'birthday-list.csv', headers, rows);
    }
    // On screen it is a list view: the phone column is masked.
    res.json(maskColumn(rows, headers.indexOf('Phone')));
  }
}
