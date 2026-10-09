-- Billing: Stripe ids only. Never card data.
CREATE TABLE IF NOT EXISTS billing_customers (
  account_id TEXT PRIMARY KEY,
  stripe_customer_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,            -- processing | processed | failed
  received_at INTEGER NOT NULL,
  processed_at INTEGER
);
CREATE TABLE IF NOT EXISTS entitlements (
  account_id TEXT PRIMARY KEY,
  plan TEXT NOT NULL,              -- byo | hub_mac | hub_nvidia | estate | none
  status TEXT NOT NULL,            -- active | trialing | past_due | canceled | incomplete | none
  billing_interval TEXT,
  stripe_subscription_id TEXT,
  current_period_end INTEGER,      -- unix seconds
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  last_event_created INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entitlements_sub ON entitlements(stripe_subscription_id);
CREATE TABLE IF NOT EXISTS hardware_orders (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  plan TEXT NOT NULL,
  checkout_session_id TEXT NOT NULL UNIQUE,
  payment_intent TEXT,
  invoice TEXT,
  amount_total INTEGER,
  currency TEXT,
  shipping_json TEXT,              -- name + address from Checkout (not card data)
  shipping_status TEXT NOT NULL DEFAULT 'pending_fulfillment',
  refunded INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hw_account ON hardware_orders(account_id);
