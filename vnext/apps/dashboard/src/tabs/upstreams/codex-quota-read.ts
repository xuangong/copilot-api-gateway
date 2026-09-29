import type { CodexQuotaResponse } from "../../api/upstreams"

export type QuotaReadState =
  | { status: "loading" }
  | { status: "ready"; result: CodexQuotaResponse }
  | { status: "error" }

// One panel owns one reader. Cancel also invalidates completions from a fetch
// implementation that ignores AbortSignal, including a late rejection.
export class CodexQuotaReader {
  private controller: AbortController | null = null

  cancel(): void {
    this.controller?.abort()
    this.controller = null
  }

  async read(
    id: string,
    fetchQuota: (id: string, signal: AbortSignal) => Promise<CodexQuotaResponse>,
    publish: (state: QuotaReadState) => void,
  ): Promise<void> {
    this.cancel()
    const controller = new AbortController()
    this.controller = controller
    publish({ status: "loading" })
    try {
      const result = await fetchQuota(id, controller.signal)
      if (this.controller === controller) publish({ status: "ready", result })
    } catch {
      if (this.controller === controller) publish({ status: "error" })
    } finally {
      if (this.controller === controller) this.controller = null
    }
  }
}
