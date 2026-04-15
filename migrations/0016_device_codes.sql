-- Device authorization codes for client app sign-in (RFC 8628 style)

CREATE TABLE IF NOT EXISTS device_codes (
  device_code TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  user_id TEXT,
  session_token TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_device_codes_user_code ON device_codes(user_code);
