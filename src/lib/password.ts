// Password hashing using Web Crypto API (PBKDF2) — compatible with Cloudflare Workers

const ITERATIONS = 100000
const KEY_LENGTH = 32 // bytes
const SALT_LENGTH = 16 // bytes

export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(SALT_LENGTH)
  crypto.getRandomValues(salt)

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  )

  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
    key,
    KEY_LENGTH * 8,
  )

  const saltHex = Array.from(salt, (b) => b.toString(16).padStart(2, "0")).join("")
  const hashHex = Array.from(new Uint8Array(derived), (b) => b.toString(16).padStart(2, "0")).join("")
  return `pbkdf2:${ITERATIONS}:${saltHex}:${hashHex}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(":")
  if (parts[0] !== "pbkdf2" || parts.length !== 4) return false

  const iterations = parseInt(parts[1]!, 10)
  const saltMatches = parts[2]!.match(/.{2}/g)
  if (!saltMatches) return false
  const salt = new Uint8Array(saltMatches.map((b) => parseInt(b, 16)))
  const expectedHash = parts[3]!

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  )

  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    KEY_LENGTH * 8,
  )

  const actualHash = Array.from(new Uint8Array(derived), (b) => b.toString(16).padStart(2, "0")).join("")
  return actualHash === expectedHash
}
