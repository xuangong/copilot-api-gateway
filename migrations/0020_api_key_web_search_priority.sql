-- Add Microsoft Grounding key and configurable priority to api_keys
-- web_search_priority: JSON string array, e.g. '["msGrounding","langsearch","tavily","bing","copilot"]'
-- Empty/NULL means: use legacy resolution (msGroundingKey override, then copilotPriority, then default chain)
ALTER TABLE api_keys ADD COLUMN web_search_ms_grounding_key TEXT;
ALTER TABLE api_keys ADD COLUMN web_search_priority TEXT;
