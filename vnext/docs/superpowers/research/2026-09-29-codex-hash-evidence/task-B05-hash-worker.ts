import { sha256Uuid, sha256UuidFromParts } from "../../../../packages/provider-codex/src/ids.ts"
export default {
  async fetch(request: Request) {
    const url = new URL(request.url)
    const size = Number(url.searchParams.get("mib") ?? "1")
    if (![1, 10].includes(size)) return new Response("unsupported", { status: 400 })
    const parts = ["x".repeat(size * 1024 * 1024), "\ud800", "\ud83d\ude00", "\u0001", JSON.stringify({ text: "漢😀".repeat(128) })]
    let finished = false
    let timerBeforeCompletion = false
    const timer = new Promise<void>(resolve => setTimeout(() => { timerBeforeCompletion = !finished; resolve() }, 0))
    const mode = url.searchParams.get("mode")
    const id = mode === "old" ? await sha256Uuid(parts.join("")) : await sha256UuidFromParts(parts)
    finished = true
    await timer
    return Response.json({ id, size, mode, timerBeforeCompletion })
  },
}
