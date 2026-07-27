// Ported from copilot-gateway packages/gateway/src/data-plane/chat/shared/text.ts.
//
// Truncate a string to at most `max` UTF-16 code units without splitting a
// surrogate pair. Used by the server-tool shim when quoting upstream error
// bodies in synthesized error envelopes: we want a bounded excerpt but not a
// broken JS string that later chokes downstream JSON.stringify.
export const truncatePreservingCodePoints = (s: string, max: number): string => {
  if (s.length <= max) return s
  let end = max
  const lastCode = s.charCodeAt(end - 1)
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) end -= 1
  return s.slice(0, end)
}
