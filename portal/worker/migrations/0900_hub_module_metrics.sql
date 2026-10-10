-- Per-module usage time series (counts and latency only, never content). One row per module per stored hub_metrics point
-- (so at most one point per Hub per 5 minutes). Values are the Hub's rolling-window counters at that moment.
CREATE TABLE IF NOT EXISTS hub_module_metrics (
  hub_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  module TEXT NOT NULL,
  requests_24h INTEGER,
  requests_7d INTEGER,
  errors_24h INTEGER,
  p50_ms INTEGER,
  PRIMARY KEY (hub_id, ts, module)
);
-- the hourly cron prunes by age across all hubs (same retention as hub_metrics)
CREATE INDEX IF NOT EXISTS idx_hub_module_metrics_ts ON hub_module_metrics(ts);
