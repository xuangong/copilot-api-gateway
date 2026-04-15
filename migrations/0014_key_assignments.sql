-- Key assignments table for sharing keys with users
CREATE TABLE key_assignments (
  key_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  assigned_by TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (key_id, user_id)
);
