-- A request, metric summaries and bounded histogram buckets are inserted by
-- one INSERT ... SELECT FROM json_each statement, so coverage is atomic.
CREATE TABLE IF NOT EXISTS performance_metrics (
  hour TEXT NOT NULL,
  key_id TEXT NOT NULL,
  dimensions TEXT NOT NULL,
  metric TEXT NOT NULL,
  upper REAL NOT NULL,
  count INTEGER NOT NULL,
  sum REAL NOT NULL,
  min REAL NOT NULL,
  max REAL NOT NULL,
  PRIMARY KEY (hour, key_id, dimensions, metric, upper)
);
CREATE INDEX IF NOT EXISTS idx_performance_metrics_hour ON performance_metrics (hour);
