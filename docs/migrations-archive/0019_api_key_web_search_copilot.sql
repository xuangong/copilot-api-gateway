-- Add Copilot web search columns to api_keys table
ALTER TABLE api_keys ADD COLUMN web_search_copilot_enabled INTEGER DEFAULT 0;
ALTER TABLE api_keys ADD COLUMN web_search_copilot_priority INTEGER DEFAULT 0;
