/** The Bun server's periodic sweep: never overlaps itself, and hands the current time to the maintenance task (which decides what is due). */
export function createMaintenanceSweep(run: (now: number) => Promise<void>, clock: () => number = Date.now): () => Promise<void> {
  let sweeping = false
  return async () => {
    if (sweeping) return
    sweeping = true
    try {
      await run(clock())
    } catch {
      console.warn(JSON.stringify({ evt: "maintenance_sweep_failed" }))
    } finally {
      sweeping = false
    }
  }
}
