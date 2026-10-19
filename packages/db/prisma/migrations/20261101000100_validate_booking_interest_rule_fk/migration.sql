-- v0.9 item 1 (2 of 2): validate bookings_interest_rule_id_fkey when it has
-- no orphan rows, the same way as 20261022000100_validate_restored_foreign_keys.
-- With orphans it stays NOT VALID (still checking new and changed rows) and
-- upgrade-native.sh and deploy/native/check-foreign-keys.sh report it. Nothing
-- is changed or deleted. VALIDATE takes SHARE UPDATE EXCLUSIVE on bookings:
-- reads and writes carry on while it scans.
DO $$
DECLARE
  orphans bigint;
BEGIN
  SELECT count(*) INTO orphans
    FROM bookings b
   WHERE b.interest_rule_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM interest_rules r WHERE r.id = b.interest_rule_id);
  IF orphans = 0 THEN
    ALTER TABLE bookings VALIDATE CONSTRAINT bookings_interest_rule_id_fkey;
  END IF;
END
$$;
