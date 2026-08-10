-- Add web search columns to api_keys table
ALTER TABLE api_keys ADD COLUMN web_search_enabled INTEGER DEFAULT 0;
ALTER TABLE api_keys ADD COLUMN web_search_bing_enabled INTEGER DEFAULT 0;
ALTER TABLE api_keys ADD COLUMN web_search_langsearch_key TEXT;
ALTER TABLE api_keys ADD COLUMN web_search_tavily_key TEXT;
