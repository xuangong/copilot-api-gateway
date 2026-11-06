/**
 * ECDSA certificate signatures through userspace TLS. Unpatched
 * @reclaimprotocol/tls sizes every DER integer to 32 bytes, so a P-384
 * signature — or any signature whose r or s is short — fails verification and
 * the whole chain is rejected. Ported from the reference's tls-signatures test
 * (#584); fixtures are its public CA certificates and offline vectors.
 */
import { createPublicKey, verify, X509Certificate } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'bun:test'
import { loadX509FromPem, setCryptoImplementation } from '@reclaimprotocol/tls'
import { webcryptoCrypto } from '@reclaimprotocol/tls/webcrypto'
import { ecdsaSignatureFixtures } from './fixtures/ecdsa-signatures.generated.ts'

const encodeDerSignature = (r: Uint8Array, s: Uint8Array): Uint8Array =>
  new Uint8Array([0x30, 4 + r.length + s.length, 0x02, r.length, ...r, 0x02, s.length, ...s])

const integers = (signature: Buffer) => {
  const rLength = signature[3] ?? 0
  return { r: signature.subarray(4, 4 + rLength), s: signature.subarray(6 + rLength) }
}

describe('userspace TLS — ECDSA signatures', () => {
  // The issuing CA's P-384 signature has a 47-byte r and a 48-byte s.
  // https://repo-certs.ssl.com/repo/certs/Cloudflare-TLS-I-E4.pem
  // https://www.ssl.com/repo/certs/SSL.com-TLS-T-ECC-R2.der
  it('verifies Cloudflare TLS Issuing ECC CA 4 with SSL.com TLS Transit ECC CA R2', async () => {
    const [certificatePem, issuerPem] = await Promise.all([
      readFile(new URL('./fixtures/cloudflare-ecc-ca-4.generated.pem', import.meta.url), 'utf8'),
      readFile(new URL('./fixtures/ssl-com-tls-transit-ecc-r2.generated.pem', import.meta.url), 'utf8'),
    ])
    expect(new X509Certificate(certificatePem).verify(new X509Certificate(issuerPem).publicKey)).toBe(true)

    setCryptoImplementation(webcryptoCrypto)
    const certificate = loadX509FromPem(certificatePem)
    const issuer = loadX509FromPem(issuerPem)
    expect(issuer.isIssuer(certificate)).toBe(true)
    expect(await issuer.verifyIssued(certificate)).toBe(true)
  })

  for (const fixture of ecdsaSignatureFixtures) {
    it(`verifies ${fixture.algorithm} with ${fixture.shape} integers`, async () => {
      const signature = Buffer.from(fixture.signature, 'base64')
      const data = Buffer.from(fixture.data, 'base64')
      const publicKey = createPublicKey(fixture.publicKey)
      expect(verify(fixture.algorithm.endsWith('SHA256') ? 'sha256' : 'sha384', data, publicKey, signature)).toBe(true)

      const { r, s } = integers(signature)
      const importedKey = await webcryptoCrypto.importKey(
        fixture.algorithm, new Uint8Array(publicKey.export({ type: 'spki', format: 'der' })), 'public',
      )
      expect(await webcryptoCrypto.verify(fixture.algorithm, { signature, data, publicKey: importedKey })).toBe(true)

      const corrupted = new Uint8Array(data)
      corrupted[0] = (corrupted[0] ?? 0) ^ 1
      expect(await webcryptoCrypto.verify(fixture.algorithm, { signature, data: corrupted, publicKey: importedKey })).toBe(false)
      await expect(webcryptoCrypto.verify(fixture.algorithm, {
        signature: encodeDerSignature(new Uint8Array([0, ...r]), s), data, publicKey: importedKey,
      })).rejects.toThrow('Invalid ECDSA signature integer')
      await expect(webcryptoCrypto.verify(fixture.algorithm, {
        signature: encodeDerSignature(r, new Uint8Array([0, ...s])), data, publicKey: importedKey,
      })).rejects.toThrow('Invalid ECDSA signature integer')
    })
  }

  for (const fixture of ecdsaSignatureFixtures.filter((candidate) => candidate.shape === 'sign-padded')) {
    it(`rejects negative and oversized DER integers for ${fixture.algorithm}`, async () => {
      const signature = Buffer.from(fixture.signature, 'base64')
      const { r, s } = integers(signature)
      const data = Buffer.from(fixture.data, 'base64')
      const publicKey = await webcryptoCrypto.importKey(
        fixture.algorithm, new Uint8Array(createPublicKey(fixture.publicKey).export({ type: 'spki', format: 'der' })), 'public',
      )
      await expect(webcryptoCrypto.verify(fixture.algorithm, {
        signature: encodeDerSignature(r.subarray(1), s), data, publicKey,
      })).rejects.toThrow('Invalid ECDSA signature integer')
      await expect(webcryptoCrypto.verify(fixture.algorithm, {
        signature: encodeDerSignature(new Uint8Array([1, ...r.subarray(1)]), s), data, publicKey,
      })).rejects.toThrow('ECDSA signature integer exceeds curve size')
    })
  }
})
