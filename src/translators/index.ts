/**
 * Protocol translators namespace.
 *
 * Files are named by protocol pair: `<client-spoken>-via-<upstream-spoken>`.
 * Current pairs:
 *   - responses-via-chat   (OpenAI Responses ⇄ Chat Completions)
 *   - gemini-via-chat      (Google Gemini ⇄ Chat Completions)
 *
 * Future translator pairs (responses-via-messages, gemini-via-messages,
 * messages-via-responses, etc.) plug in here without leaking into the
 * services/ directory which is reserved for upstream-IO concerns.
 *
 * For now this is a re-export shim — the actual translation logic still
 * lives under services/responses and services/gemini. Migrating those
 * files in-place would touch every test; doing it as a re-export gives
 * callers a stable import path to migrate to without breaking anything.
 */

export * as responsesViaChat from "./responses-via-chat"
export * as geminiViaChat from "./gemini-via-chat"
export * as messagesViaResponses from "./messages-via-responses/request"
export * as chatCompletionsViaMessages from "./chat-completions-via-messages/request"
