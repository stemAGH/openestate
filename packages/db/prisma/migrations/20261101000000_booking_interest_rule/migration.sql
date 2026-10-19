-- v0.9 item 1 (1 of 2): attaching a delay-interest rule to a booking.
--
-- bookings.interest_from_date: delay interest runs only from this date (the
-- day a rule is attached or changed, or the transfer date). Nullable, no
-- default: a metadata-only change, no table rewrite. Existing bookings are not
-- changed; none has a rule, because nothing could attach one before this
-- release.
--
-- bookings_interest_rule_id_fkey goes from ON DELETE SET NULL to RESTRICT.
-- SET NULL meant deleting a rule silently switched off interest on every
-- booking it was attached to. PostgreSQL cannot change a foreign key's ON
-- DELETE in place, so it is dropped and re-added in this one transaction (no
-- moment without a constraint). Re-added NOT VALID, as in v0.8.4: new and
-- changed rows are checked at once, existing rows are not scanned here; the
-- next migration validates it when it has no orphan rows. The locks (ACCESS
-- EXCLUSIVE on bookings, briefly) fall under upgrade-native.sh's lock_timeout.
ALTER TABLE "bookings" ADD COLUMN "interest_from_date" DATE;

-- ALLOW-DROP: re-added just below with ON DELETE RESTRICT (was SET NULL); same transaction.
ALTER TABLE "bookings" DROP CONSTRAINT "bookings_interest_rule_id_fkey";
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_interest_rule_id_fkey" FOREIGN KEY ("interest_rule_id") REFERENCES "interest_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
