-- Observability sharing — owner grants viewer read-only access to observability data
CREATE TABLE observability_shares (
  owner_id TEXT NOT NULL,
  viewer_id TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, viewer_id)
);
CREATE INDEX idx_observability_shares_viewer ON observability_shares(viewer_id);
