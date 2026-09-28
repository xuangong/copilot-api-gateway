const NativeTextEncoder = TextEncoder
let maxBytes = 0
let calls = 0
globalThis.TextEncoder = class extends NativeTextEncoder {
  encode(input) {
    const bytes = super.encode(input)
    maxBytes = Math.max(maxBytes, bytes.byteLength)
    calls++
    return bytes
  }
}

const { sha256Utf8Parts } = await import('../../../../packages/provider-llm/src/incremental-sha256.ts')
const cases = [
  ['ASCII', ['x'.repeat(1024 * 1024)]],
  ['BMP', ['漢'.repeat(1024 * 1024)]],
  ['emoji', ['\ud83d\ude00'.repeat(1024 * 1024)]],
  ['split', ['x'.repeat(16383) + '\ud83d', '', '\ude00'.repeat(1024 * 1024)]],
]
const results = []
for (const [name, parts] of cases) {
  maxBytes = 0
  calls = 0
  const digest = await sha256Utf8Parts(parts)
  results.push({ name, maxBytes, calls, digestBytes: digest.byteLength })
}
console.log(JSON.stringify(results))
