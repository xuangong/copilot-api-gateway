/**
 * Protocol type barrel.
 *
 * Stable import surface for protocol shapes used across translators,
 * providers, and routes. Per-protocol modules live under namespaced
 * subdirectories so each protocol's surface stays auditable.
 */

export * as common from "./common"
export * as chatCompletions from "./chat-completions"
export * as responses from "./responses"
export * as messages from "./messages"
export * as gemini from "./gemini"
export * as embeddings from "./embeddings"
