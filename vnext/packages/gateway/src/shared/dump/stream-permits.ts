// Counts route owners including detached subscriptions with unsettled SQL/writes.
export class DumpStreamPermits {
  private total = 0
  private readonly byKey = new Map<string, number>()

  acquire(keyId: string): (() => void) | null {
    const count = this.byKey.get(keyId) ?? 0
    if (count >= 4 || this.total >= 16) return null
    this.total++
    this.byKey.set(keyId, count + 1)
    let retired = false
    return () => {
      if (retired) return
      retired = true
      this.total--
      const remaining = (this.byKey.get(keyId) ?? 1) - 1
      if (remaining === 0) this.byKey.delete(keyId)
      else this.byKey.set(keyId, remaining)
    }
  }
}
