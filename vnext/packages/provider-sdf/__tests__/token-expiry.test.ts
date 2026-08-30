/**
 * `substrateTokenExpiry` reads the `exp` claim out of a Substrate bearer without
 * a network round trip, so an operator can be told the token is dead instead of
 * being handed Substrate's `LLM API: Unauthorized access` and left to guess
 * between expiry, permissions and a missing model.
 *
 * It decodes and never verifies. That is safe precisely because nothing
 * authorizes on the result: a forged `exp` would only mislead the operator about
 * their own token. The tests below therefore feed it unsigned JWTs.
 *
 * The contract that matters is the asymmetry: a past `exp` is proof the token is
 * dead, a future one is no proof it is alive. Everything the function cannot
 * read must come back null so callers stay silent rather than guessing.
 */
import { test, expect } from 'bun:test'
import { substrateTokenExpiry } from '../src/provider'

const b64url = (o: unknown) =>
  btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const jwt = (claims: Record<string, unknown>) =>
  `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(claims)}.sig`

test('returns the exp claim verbatim, in Unix seconds', () => {
  // The real value off the expired local upstream that prompted this function.
  expect(substrateTokenExpiry(jwt({ exp: 1787975127, tid: 'acme' }))).toBe(1787975127)
})

test('an exp in the future comes back unchanged — no verdict is rendered here', () => {
  // The caller decides what a future exp means. This function only reports.
  expect(substrateTokenExpiry(jwt({ exp: 4102444800 }))).toBe(4102444800)
})

test('a token with other claims but no exp is null, not zero', () => {
  // Zero would read as 1970 and mark every such token permanently expired.
  expect(substrateTokenExpiry(jwt({ tid: 'acme', aud: 'https://substrate.office.com' }))).toBeNull()
})

test('a non-numeric exp is rejected rather than coerced', () => {
  expect(substrateTokenExpiry(jwt({ exp: '1787975127' }))).toBeNull()
})

test('base64url padding and the - _ alphabet both decode', () => {
  // Real Entra tokens are base64url and unpadded; treating them as plain base64
  // is the classic way this kind of helper silently returns null in production
  // while passing every hand-written test.
  const token = jwt({ exp: 1787975127, name: 'a?b>c~d', sub: 'ÿÿÿ' })
  expect(token).not.toContain('=')
  expect(substrateTokenExpiry(token)).toBe(1787975127)
})

test('anything that is not a readable JWT is null and never throws', () => {
  for (const bad of ['', 'not-a-jwt', 'a.b', 'a.!!!!.c', 'a..c', '..']) {
    expect(substrateTokenExpiry(bad)).toBeNull()
  }
})

test('a payload that decodes to a non-object is null', () => {
  // `JSON.parse('7')` succeeds; reading `.exp` off it would not.
  expect(substrateTokenExpiry(`h.${b64url(7)}.s`)).toBeNull()
  expect(substrateTokenExpiry(`h.${b64url([1, 2])}.s`)).toBeNull()
  expect(substrateTokenExpiry(`h.${b64url(null)}.s`)).toBeNull()
})
