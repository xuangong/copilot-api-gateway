import type { MessagesInterceptor } from "./types"

// Keep the hint until provider dispatch. Only per-call execution metadata (or
// the native upstream response) may report that the accelerated lane ran.
export const withSpeedFast: MessagesInterceptor = async (_inv, _ctx, run) => run()
