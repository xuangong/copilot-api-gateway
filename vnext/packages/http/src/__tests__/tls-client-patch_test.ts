/**
 * Behaviour the pinned @reclaimprotocol/tls patch adds and this repo's callers
 * rely on. Without the patch, `dialReality` registers hooks that never run and
 * an IP-literal upstream is announced as an SNI host name, which RFC 6066
 * forbids. Both show up in the ClientHello the client writes.
 */
import { describe, expect, it } from 'bun:test'
import { makeTLSClient, setCryptoImplementation } from '@reclaimprotocol/tls'
import { webcryptoCrypto } from '@reclaimprotocol/tls/webcrypto'

// The patch adds these options; the package's own typings never learned them.
interface PatchedHooks {
  onKeyPairGenerated?: (keyType: string) => void
  onClientHelloPack?: (clientHello: Uint8Array) => Uint8Array | undefined
}

// The ClientHello's session_id: 4-byte handshake header, 2-byte version,
// 32-byte random, 1-byte session_id length.
const SESSION_ID = { start: 39, end: 71 }

async function writtenClientHello(host: string, hooks: PatchedHooks = {}): Promise<Uint8Array> {
  setCryptoImplementation(webcryptoCrypto)
  const written: Uint8Array[] = []
  const client = makeTLSClient({
    host,
    verifyServerCertificate: false,
    write: async ({ content }: { content: Uint8Array }) => { written.push(content) },
    ...hooks,
  } as Parameters<typeof makeTLSClient>[0])
  await client.startHandshake()
  const hello = written[0]
  if (!hello) throw new Error('no ClientHello written')
  return hello
}

const carries = (bytes: Uint8Array, text: string): boolean => Buffer.from(bytes).includes(Buffer.from(text))

describe('patched userspace TLS client', () => {
  it('runs the REALITY hooks and sends the ClientHello they rewrote', async () => {
    const seen: string[] = []
    const hello = await writtenClientHello('gateway.example', {
      onKeyPairGenerated: (keyType) => { seen.push(`key:${keyType}`) },
      onClientHelloPack: (clientHello) => {
        seen.push('hello')
        const sealed = new Uint8Array(clientHello)
        sealed.fill(0xaa, SESSION_ID.start, SESSION_ID.end)
        return sealed
      },
    })
    expect(seen.some((entry) => entry.startsWith('key:'))).toBe(true)
    expect(seen.filter((entry) => entry === 'hello')).toHaveLength(1)
    expect([...hello.subarray(SESSION_ID.start, SESSION_ID.end)].every((byte) => byte === 0xaa)).toBe(true)
  })

  it('names a DNS host in SNI but never an IP literal', async () => {
    expect(carries(await writtenClientHello('gateway.example'), 'gateway.example')).toBe(true)
    expect(carries(await writtenClientHello('203.0.113.7'), '203.0.113.7')).toBe(false)
  })
})
