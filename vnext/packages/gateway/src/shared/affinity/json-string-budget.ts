import { Buffer } from "node:buffer"

/** Exact UTF-8 size of JSON.stringify over the concatenated string. */
export class JsonStringBudget {
  private bytes = 2
  private trailingHighSurrogate = false

  constructor(initial = "") { this.append(initial) }

  get byteLength(): number { return this.bytes }

  append(fragment: string): void {
    if (fragment.length === 0) return
    const first = fragment.charCodeAt(0)
    const last = fragment.charCodeAt(fragment.length - 1)
    // Independently escaped lone halves cost 6 + 6 bytes; a joined pair costs
    // 4. Charge the trailing half immediately, then repair only when joined.
    const joinedPair = this.trailingHighSurrogate && first >= 0xdc00 && first <= 0xdfff
    this.bytes += Buffer.byteLength(JSON.stringify(fragment), "utf8") - 2 - (joinedPair ? 8 : 0)
    this.trailingHighSurrogate = last >= 0xd800 && last <= 0xdbff
  }
}
