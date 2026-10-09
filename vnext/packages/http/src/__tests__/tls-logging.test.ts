import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { userspaceTls } from "../tls.ts"
import { makeFakeDuplex } from "./test-utils.ts"

describe("userspace TLS console policy", () => {
  const originalDebug = process.env.DEBUG_USERSPACE_TLS
  const output: string[] = []
  let restore: Array<() => void> = []

  beforeEach(() => {
    delete process.env.DEBUG_USERSPACE_TLS
    output.length = 0
    restore = (["debug", "info", "warn", "error"] as const).map(level => {
      const spy = spyOn(console, level).mockImplementation((...args: unknown[]) => {
        output.push(JSON.stringify({ level, args }))
      })
      return () => spy.mockRestore()
    })
  })

  afterEach(() => {
    for (const reset of restore) reset()
    if (originalDebug === undefined) delete process.env.DEBUG_USERSPACE_TLS
    else process.env.DEBUG_USERSPACE_TLS = originalDebug
  })

  async function receive(records: number[]) {
    const transport = makeFakeDuplex()
    const handshake = userspaceTls(transport, { host: "example.com" })
    transport.respond(new Uint8Array(records))
    transport.endResponse()
    await expect(handshake).rejects.toBeInstanceOf(Error)
  }

  it("suppresses normal change-cipher-spec and close-notify output by default", async () => {
    await receive([20, 3, 3, 0, 1, 1])
    await receive([21, 3, 3, 0, 2, 1, 0])
    expect(output).toEqual([])
  })

  it("keeps fatal alerts visible and still rejects the handshake", async () => {
    await receive([21, 3, 3, 0, 2, 2, 40])
    expect(output.join("\n")).toContain("HANDSHAKE_FAILURE")
    expect(output.join("\n")).toContain("userspace-tls")
  })

  it("does not hide other warnings or a fatal close-notify", async () => {
    await receive([21, 3, 3, 0, 2, 1, 90])
    await receive([21, 3, 3, 0, 2, 2, 0])
    const logs = output.join("\n")
    expect(logs).toContain("USER_CANCELED")
    expect(logs).toContain("FATAL")
    expect(logs).toContain("CLOSE_NOTIFY")
  })

  it("enables safe debug events explicitly without packet payloads", async () => {
    process.env.DEBUG_USERSPACE_TLS = "1"
    // Unknown record: the dependency puts raw bytes in its warning details.
    await receive([99, 3, 3, 0, 4, 0xde, 0xad, 0xbe, 0xef, 20, 3, 3, 0, 1, 1])
    const logs = output.join("\n")
    expect(logs).toContain("received change cipher spec")
    expect(logs).toContain("cannot process message")
    expect(logs).not.toContain("de ad be ef")
    expect(logs).not.toContain("chunk")
  })

  it("does not enable verbose logging for DEBUG_USERSPACE_TLS=0", async () => {
    process.env.DEBUG_USERSPACE_TLS = "0"
    await receive([20, 3, 3, 0, 1, 1])
    expect(output).toEqual([])
  })
})
