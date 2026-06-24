/**
 * GitHub Copilot account flavor. Lives in @vnext-llm/protocols/common because
 * both the gateway package and provider-copilot package consume it; keeping
 * one definition prevents drift. Copilot-specific URL helpers and version
 * strings stay in provider-copilot/src/account-type.ts.
 */
export type AccountType = 'individual' | 'business' | 'enterprise'
