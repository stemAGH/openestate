import { Controller, Get, Inject, Param, Query, Req, Res } from '@nestjs/common';
import { PrismaClient } from '@openestate/db';
import { SYSTEM_PRISMA } from '../database/database.module';
import { auditExport, maskColumn, requireExport } from './export-gate';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { reportDateRangeSchema, PERMISSIONS } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { BrokerReportsService } from './broker-reports.service';
import { streamCsv } from './csv-stream.util';

class ReportQueryDto extends createZodDto(reportDateRangeSchema) {}
// sold-units accepts an optional brokerId filter — reportDateRangeSchema is
// .strict(), so a plain @Query('brokerId') alongside @Query() ReportQueryDto
// fails validation (unrecognized key); extend the schema instead. Exported
// for a direct schema-level regression test (commission-pure.test.ts) —
// calling the controller method directly bypasses Nest's validation pipe,
// so only a schema-level test actually catches this class of bug.
export const soldUnitsQuerySchema = reportDateRangeSchema.extend({ brokerId: z.string().uuid().optional() });
class SoldUnitsQueryDto extends createZodDto(soldUnitsQuerySchema) {}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

@ApiTags('Broker Reports')
@Controller('reports/brokers')
export class BrokerReportsController {
  constructor(
    private readonly reports: BrokerReportsService,
    @Inject(SYSTEM_PRISMA) private readonly prisma: PrismaClient,
  ) {}

  /**
   * CSV: full data leaves the system, so it needs presales.report.export and
   * writes an audit row. JSON (on screen) stays on the view permission, with
   * any Phone column masked, as in every list view.
   */
  private async respond(
    u: JwtPayload, req: Request, res: Response, format: string | undefined,
    reportKey: string, filename: string, headers: string[], rows: AsyncIterable<unknown[]>, filters: object,
  ) {
    if (format === 'csv') requireExport(u);
    const all = await collect(rows);
    if (format === 'csv') {
      await auditExport(this.prisma, { user: u, entityType: 'BrokerReport', reportKey, filters, rowCount: all.length, ip: req.ip });
      return streamCsv(res, filename, headers, all);
    }
    const phone = headers.indexOf('Phone');
    res.json(phone >= 0 ? maskColumn(all, phone) : all);
  }

  @Get('sold-units')
  @RequirePermissions(PERMISSIONS.REPORTS_BROKER_VIEW)
  @ApiOperation({ summary: 'Broker-wise sold units (streamed CSV supported)' })
  async soldUnits(@Query() q: SoldUnitsQueryDto, @Req() req: Request, @Res() res: Response) {
    const u = req.user as JwtPayload;
    const headers = ['Broker', 'Booking No.', 'Applicant', 'Unit', 'Agreed Price', 'Status'];
    const gen = this.reports.soldUnits(u.companyId, q.brokerId);
    return this.respond(u, req, res, q.format, 'sold-units', 'broker-sold-units.csv', headers, gen, q);
  }

  @Get('commission-summary')
  @RequirePermissions(PERMISSIONS.REPORTS_BROKER_VIEW)
  @ApiOperation({ summary: 'Commission summary per broker: accrued, paid, TDS, clawed back, outstanding (streamed CSV supported)' })
  async commissionSummary(@Query() q: ReportQueryDto, @Req() req: Request, @Res() res: Response) {
    const u = req.user as JwtPayload;
    const headers = ['Broker', 'Accrued', 'Paid', 'TDS Withheld', 'Clawed Back', 'Outstanding'];
    const gen = this.reports.commissionSummary(u.companyId);
    return this.respond(u, req, res, q.format, 'commission-summary', 'broker-commission-summary.csv', headers, gen, q);
  }

  @Get('dues')
  @RequirePermissions(PERMISSIONS.REPORTS_BROKER_VIEW)
  @ApiOperation({ summary: 'Brokers with outstanding commission dues (streamed CSV supported)' })
  async dues(@Query() q: ReportQueryDto, @Req() req: Request, @Res() res: Response) {
    const u = req.user as JwtPayload;
    const headers = ['Broker', 'Phone', 'Outstanding'];
    const gen = this.reports.dues(u.companyId);
    return this.respond(u, req, res, q.format, 'dues', 'broker-dues.csv', headers, gen, q);
  }

  @Get(':brokerId/customer-detail')
  @RequirePermissions(PERMISSIONS.REPORTS_BROKER_VIEW)
  @ApiOperation({ summary: 'Customer-wise detail for one broker (streamed CSV supported)' })
  async customerDetail(@Param('brokerId') brokerId: string, @Query() q: ReportQueryDto, @Req() req: Request, @Res() res: Response) {
    const u = req.user as JwtPayload;
    const headers = ['Applicant', 'Booking No.', 'Unit', 'Agreed Price', 'Commission Accrued', 'Commission Paid', 'Outstanding'];
    const gen = this.reports.customerDetail(u.companyId, brokerId);
    return this.respond(u, req, res, q.format, 'customer-detail', `broker-${brokerId}-customer-detail.csv`, headers, gen, { ...q, brokerId });
  }

  @Get('summary')
  @RequirePermissions(PERMISSIONS.REPORTS_BROKER_VIEW)
  @ApiOperation({ summary: 'Company-wide broker/commission rollup' })
  async summary(@Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.reports.summary(u.companyId);
  }
}
