import { describe, expect, test } from "bun:test"
import { runInterceptors, type Interceptor } from "~/providers/interceptor"

interface Ctx { trace: string[] }
type Inv = { value: number }
type Itc = Interceptor<Inv, Ctx, string>

describe("runInterceptors", () => {
  test("empty array calls terminal", async () => {
    const result = await runInterceptors<Inv, Ctx, string>(
      { value: 1 }, { trace: [] }, [], async () => "terminal",
    )
    expect(result).toBe("terminal")
  })

  test("invokes interceptors in array order, terminal last", async () => {
    const ctx: Ctx = { trace: [] }
    const a: Itc = async (_inv, c, run) => { c.trace.push("a-pre"); const r = await run(); c.trace.push("a-post"); return r }
    const b: Itc = async (_inv, c, run) => { c.trace.push("b-pre"); const r = await run(); c.trace.push("b-post"); return r }
    const result = await runInterceptors<Inv, Ctx, string>(
      { value: 0 }, ctx, [a, b], async () => { ctx.trace.push("terminal"); return "ok" },
    )
    expect(result).toBe("ok")
    expect(ctx.trace).toEqual(["a-pre", "b-pre", "terminal", "b-post", "a-post"])
  })

  test("interceptor can mutate invocation before run() and read result after", async () => {
    const ctx: Ctx = { trace: [] }
    const mutator: Itc = async (inv, _c, run) => { inv.value = 42; return run() }
    const result = await runInterceptors<Inv, Ctx, string>(
      { value: 0 }, ctx, [mutator], async () => "done",
    )
    expect(result).toBe("done")
  })

  test("interceptor can short-circuit without calling run()", async () => {
    let terminalCalled = false
    const guard: Itc = async () => "short-circuit"
    const result = await runInterceptors<Inv, Ctx, string>(
      { value: 0 }, { trace: [] }, [guard],
      async () => { terminalCalled = true; return "unused" },
    )
    expect(result).toBe("short-circuit")
    expect(terminalCalled).toBe(false)
  })

  test("terminal rejection propagates to caller", async () => {
    await expect(
      runInterceptors<Inv, Ctx, string>(
        { value: 0 }, { trace: [] }, [],
        async () => { throw new Error("terminal-boom") },
      ),
    ).rejects.toThrow("terminal-boom")
  })

  test("interceptor rejection short-circuits and propagates", async () => {
    let terminalCalled = false
    const thrower: Itc = async () => { throw new Error("itc-boom") }
    await expect(
      runInterceptors<Inv, Ctx, string>(
        { value: 0 }, { trace: [] }, [thrower],
        async () => { terminalCalled = true; return "unused" },
      ),
    ).rejects.toThrow("itc-boom")
    expect(terminalCalled).toBe(false)
  })

  test("interceptor can catch downstream rejection and recover", async () => {
    const recover: Itc = async (_inv, _c, run) => {
      try { return await run() } catch { return "recovered" }
    }
    const result = await runInterceptors<Inv, Ctx, string>(
      { value: 0 }, { trace: [] }, [recover],
      async () => { throw new Error("downstream") },
    )
    expect(result).toBe("recovered")
  })
})
