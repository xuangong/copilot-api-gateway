/**
 * Re-export of the framework probe helper. The real implementation lives in
 * @vnext-gateway/upstream — kept here as a bridge so existing
 * `@vnext-llm/provider-llm/probe` import paths still resolve while Spec 9 Part 2
 * migrates consumers.
 */
export { probeViaModels } from '@vnext-gateway/upstream'
