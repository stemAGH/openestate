-- v0.10.1 (Plan D, owner ruling 2026-11-17): a free-text remark on a booking.
-- bookings is a frozen table; this adds one nullable column and nothing else:
-- no default, no constraint, no index, a metadata-only change with no table
-- rewrite. No existing row changes.
ALTER TABLE "bookings" ADD COLUMN "remark" VARCHAR(1000);
