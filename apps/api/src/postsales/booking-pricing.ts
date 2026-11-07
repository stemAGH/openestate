import { BadRequestException, NotFoundException } from '@nestjs/common';
import { isIntraStateSupply, type CreateBookingDto, type CostLineKindValue } from '@openestate/shared';
import { computeCostLineGst } from './gst.util';

/**
 * The cost-line and GST pricing of a booking, moved unchanged out of
 * BookingService.createBooking so the booking quote can run the same code
 * without writing anything. Reads only (charge types, GST rates) through the
 * given transaction client. The equivalence property test
 * (booking-pricing-equivalence.test.ts) holds it to the original.
 */
export async function priceCostLines(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  companyId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  unit: { project: { areaLocation?: { stateCode?: string | null } | null } } & Record<string, any>,
  config: { gstStateCode?: string | null } | null,
  dto: Pick<CreateBookingDto, 'placeOfSupplyStateCode' | 'costLines'>,
) {
        // Place of supply: explicit override, else the property's area-location
        // state code (IGST Act §12(3)(a) — location of the immovable property).
        const placeOfSupplyStateCode =
          dto.placeOfSupplyStateCode ??
          unit.project.areaLocation?.stateCode ??
          null;
        let intraState: boolean;
        try {
          intraState = isIntraStateSupply(config?.gstStateCode, placeOfSupplyStateCode);
        } catch (e) {
          throw new BadRequestException((e as Error).message);
        }

        // Compute the cost breakup with GST snapshots.
        const costLines: Array<{
          kind: CostLineKindValue;
          chargeTypeId: string | null;
          label: string;
          baseAmountPaise: bigint;
          gstRateId: string | null;
          gstRatePercentSnapshot: number;
          cgstPaise: bigint;
          sgstPaise: bigint;
          igstPaise: bigint;
          lineTotalPaise: bigint;
          sortOrder: number;
        }> = [];

        // GST-rate resolution order per line: its own gstRateId, else its
        // charge type's gstRateId (ChargeType.gstRateId, set via Masters),
        // else the booking's own BASE line rate. PLC lines never carry a
        // chargeType (PlcType is unrelated to GstRate) so they always fall
        // through to the base rate. A line that still has no resolvable
        // rate after all three steps is a hard error, never an implicit
        // 0% — an unset rate would silently understate an invoice, and
        // the whole point of this resolution order is that a builder who
        // sets a base-line rate never has to think about it again for
        // PLC/OTHER lines that don't carry their own.
        const baseLineGstRateId = dto.costLines.find((l) => l.kind === 'BASE')?.gstRateId ?? null;

        for (let i = 0; i < dto.costLines.length; i++) {
          const line = dto.costLines[i];

          let effectiveGstRateId = line.gstRateId ?? null;
          if (!effectiveGstRateId && line.chargeTypeId) {
            const ct = await tx.chargeType.findFirst({ where: { id: line.chargeTypeId, companyId } });
            if (!ct) throw new NotFoundException(`Charge type ${line.chargeTypeId} not found`);
            effectiveGstRateId = ct.gstRateId ?? null;
          }
          effectiveGstRateId ??= baseLineGstRateId;

          if (!effectiveGstRateId) {
            throw new BadRequestException(
              `Cannot determine GST for cost line "${line.label}": select a GST rate for the ` +
                'base line (fixes every line that falls back to it), or set one for this charge ' +
                'type in Masters.',
            );
          }

          let ratePercent = 0;
          {
            const gr = await tx.gstRate.findFirst({ where: { id: effectiveGstRateId, companyId } });
            if (!gr) throw new NotFoundException(`GST rate ${effectiveGstRateId} not found`);
            ratePercent = Number(gr.rate);
          }
          const gst = computeCostLineGst(line.baseAmountPaise, ratePercent, intraState);
          costLines.push({
            kind: line.kind,
            chargeTypeId: line.chargeTypeId ?? null,
            label: line.label,
            baseAmountPaise: line.baseAmountPaise,
            gstRateId: effectiveGstRateId,
            gstRatePercentSnapshot: ratePercent,
            cgstPaise: gst.cgstPaise,
            sgstPaise: gst.sgstPaise,
            igstPaise: gst.igstPaise,
            lineTotalPaise: gst.lineTotalPaise,
            sortOrder: i,
          });
        }

        const agreedPricePaise = costLines.reduce((s, l) => s + l.lineTotalPaise, 0n);

        return { placeOfSupplyStateCode, costLines, agreedPricePaise };
}
