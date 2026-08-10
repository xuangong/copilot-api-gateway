ALTER TABLE users ADD COLUMN user_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_key ON users(user_key);
