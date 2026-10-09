-- Security hardening (GPT-6 review 2026-10-09).
-- Entitlement writes are ordered by (event created, event id) inside the UPSERT itself.
ALTER TABLE entitlements ADD COLUMN last_event_id TEXT NOT NULL DEFAULT '';

-- Hardware order payment/refund tracking. shipping_status also takes awaiting_payment | payment_failed.
ALTER TABLE hardware_orders ADD COLUMN hardware_amount INTEGER;                 -- hardware line total incl. tax, from Stripe line items
ALTER TABLE hardware_orders ADD COLUMN refunded_amount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hardware_orders ADD COLUMN refund_status TEXT NOT NULL DEFAULT 'none'; -- none | partially_refunded | refunded

-- Cumulative refund per Stripe charge, kept independently of orders so a refund that arrives first is not lost.
CREATE TABLE IF NOT EXISTS refunds (
  charge_id TEXT PRIMARY KEY,
  payment_intent TEXT,
  invoice TEXT,
  amount_refunded INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refunds_pi ON refunds(payment_intent);
CREATE INDEX IF NOT EXISTS idx_refunds_inv ON refunds(invoice);

-- At most one open subscription purchase per account.
CREATE TABLE IF NOT EXISTS checkout_pending (
  account_id TEXT PRIMARY KEY,
  pending_id TEXT NOT NULL,
  plan TEXT NOT NULL,
  interval TEXT NOT NULL,
  session_id TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkout_pending_session ON checkout_pending(session_id);
