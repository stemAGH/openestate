-- v0.10.1 (1 of 2): deleted leads. A lead (inquiry) is deleted softly: it is
-- hidden from every screen, report and job until a holder of
-- presales.lead.delete restores it, and purged after the company's retention
-- period (company_configs.lead_purge_after_days, default 30).
--
-- New nullable columns, no default: a metadata-only change, no table rewrite;
-- no existing lead is deleted. deleted_by_id's foreign key is added NOT VALID
-- (new and changed rows are checked at once; existing rows are all NULL) and
-- validated by the next migration, the v0.9 pattern. delete_reason holds one
-- of the reasons the API accepts (DUPLICATE, JUNK_OR_TEST, CUSTOMER_REQUEST,
-- OTHER); delete_note is the operator's text, with phone numbers masked.
ALTER TABLE "inquiries" ADD COLUMN "deleted_at" TIMESTAMP(3),
  ADD COLUMN "deleted_by_id" UUID,
  ADD COLUMN "delete_reason" VARCHAR(30),
  ADD COLUMN "delete_note" VARCHAR(500);

ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_deleted_by_id_fkey" FOREIGN KEY ("deleted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

-- Serves the deleted-leads list and the purge job.
CREATE INDEX "inquiries_company_id_deleted_at_idx" ON "inquiries"("company_id", "deleted_at");

ALTER TABLE "company_configs" ADD COLUMN "lead_purge_after_days" INTEGER NOT NULL DEFAULT 30;
