-- Add email column to users table
ALTER TABLE users ADD COLUMN email TEXT;
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Add email column to invite_codes table
ALTER TABLE invite_codes ADD COLUMN email TEXT;
