-- Hub telemetry: latest stats snapshot (validated JSON, operational numbers only) and a thin time series.
ALTER TABLE hubs ADD COLUMN stats_json TEXT;

CREATE TABLE IF NOT EXISTS hub_metrics (
  hub_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  cpu REAL,
  mem_pct REAL,
  gpu_util REAL,
  gpu_mem_pct REAL,
  latency_ms INTEGER,
  PRIMARY KEY (hub_id, ts)
);
-- the hourly cron prunes by age across all hubs
CREATE INDEX IF NOT EXISTS idx_hub_metrics_ts ON hub_metrics(ts);
