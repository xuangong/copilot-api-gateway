-- Add password_hash column to users table for email+password login
ALTER TABLE users ADD COLUMN password_hash TEXT;
