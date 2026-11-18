-- v0.10.1 (owner ruling 2026-11-18): a separate bounce charge for the company's
-- own refund cheques. Until now a bounced refund cheque charged the customer
-- the receipt-cheque setting (cheque_bounce_charge_paise). The new setting
-- defaults to 0, so every existing install charges nothing on a bounced refund
-- cheque until an admin sets it. NOT NULL with a constant default: a
-- metadata-only change, no table rewrite.
ALTER TABLE "company_configs" ADD COLUMN "refund_cheque_bounce_charge_paise" BIGINT NOT NULL DEFAULT 0;
