import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import {
  createBrokerSchema,
  updateBrokerSchema,
  brokerBankDetailSchema,
  sortableListQuerySchema,
  PERMISSIONS,
} from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { BrokerService } from './broker.service';

class CreateBrokerDto extends createZodDto(createBrokerSchema) {}
class UpdateBrokerDto extends createZodDto(updateBrokerSchema) {}
class BrokerBankDetailDto extends createZodDto(brokerBankDetailSchema) {}
// Sortable only by the columns the list shows.
class PaginationQueryDto extends createZodDto(sortableListQuerySchema(['name'] as const)) {}

@ApiTags('Brokers')
@Controller('brokers')
export class BrokerController {
  constructor(private readonly brokers: BrokerService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ADMIN_BROKER_READ)
  @ApiOperation({ summary: 'List brokers' })
  findAll(@Query() query: PaginationQueryDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.brokers.findAll(u.companyId, query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_BROKER_READ)
  @ApiOperation({ summary: 'Get a broker (bank details included, PAN masked)' })
  findOne(@Param('id') id: string, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.brokers.findOne(u.companyId, id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.ADMIN_BROKER_CREATE)
  @ApiOperation({ summary: 'Create a broker (PAN encrypted at rest)' })
  create(@Body() dto: CreateBrokerDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.brokers.create(u.companyId, dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_BROKER_UPDATE)
  @ApiOperation({ summary: 'Update a broker' })
  update(@Param('id') id: string, @Body() dto: UpdateBrokerDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.brokers.update(u.companyId, id, dto);
  }

  @Post(':id/deactivate')
  @RequirePermissions(PERMISSIONS.ADMIN_BROKER_UPDATE)
  @ApiOperation({ summary: 'Deactivate a broker (soft — feeds NOC auto-approval for future cancellations)' })
  deactivate(@Param('id') id: string, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.brokers.deactivate(u.companyId, id);
  }

  @Post(':id/reactivate')
  @RequirePermissions(PERMISSIONS.ADMIN_BROKER_UPDATE)
  @ApiOperation({ summary: 'Reactivate a broker' })
  reactivate(@Param('id') id: string, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.brokers.reactivate(u.companyId, id);
  }

  @Get(':id/bank-details')
  @RequirePermissions(PERMISSIONS.ADMIN_BROKER_READ)
  @ApiOperation({ summary: 'List a broker\'s bank details' })
  listBankDetails(@Param('id') id: string, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.brokers.listBankDetails(u.companyId, id);
  }

  @Post(':id/bank-details')
  @RequirePermissions(PERMISSIONS.ADMIN_BROKER_UPDATE)
  @ApiOperation({ summary: 'Add a bank detail for a broker' })
  addBankDetail(@Param('id') id: string, @Body() dto: BrokerBankDetailDto, @Req() req: Request) {
    const u = req.user as JwtPayload;
    return this.brokers.addBankDetail(u.companyId, id, dto);
  }

  @Get(':id/pan')
  @RequirePermissions(PERMISSIONS.ADMIN_BROKER_UPDATE)
  @ApiOperation({ summary: 'Reveal the decrypted PAN (audited read, never in list responses)' })
  async revealPan(@Param('id') id: string, @Req() req: Request) {
    const u = req.user as JwtPayload;
    const pan = await this.brokers.revealPan(u.companyId, id);
    return { pan };
  }
}
