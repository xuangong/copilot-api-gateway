// Reshape an already-aborted signal into a throwable Error. A structured
// Error reason rethrows as-is so its stack/cause survive; a primitive or
// absent reason becomes a DOMException('AbortError').
export const signalAbortReason = (signal: AbortSignal): Error => {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException(String(reason ?? 'aborted'), 'AbortError');
};

// Cloudflare Workers and undici wrap aborts as a TypeError carrying the real
// AbortError on `cause`, so a plain `name` check misses them.
export const isAbortError = (err: unknown): boolean => {
  for (let cur: unknown = err; cur != null; cur = (cur as { cause?: unknown }).cause) {
    if (cur instanceof DOMException && cur.name === 'AbortError') return true;
    if (cur instanceof Error && cur.name === 'AbortError') return true;
  }
  return false;
};
