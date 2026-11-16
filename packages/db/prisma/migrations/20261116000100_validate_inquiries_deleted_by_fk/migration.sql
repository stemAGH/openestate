-- v0.10.1 (2 of 2): validate inquiries_deleted_by_id_fkey, added NOT VALID by
-- the previous migration. Every existing row has deleted_by_id NULL, so there
-- are no orphans; the check is kept for the same shape as
-- 20261101000100_validate_booking_interest_rule_fk. VALIDATE takes SHARE
-- UPDATE EXCLUSIVE on inquiries: reads and writes carry on while it scans.
DO $$
DECLARE
  orphans bigint;
BEGIN
  SELECT count(*) INTO orphans
    FROM inquiries i
   WHERE i.deleted_by_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = i.deleted_by_id);
  IF orphans = 0 THEN
    ALTER TABLE inquiries VALIDATE CONSTRAINT inquiries_deleted_by_id_fkey;
  END IF;
END
$$;
