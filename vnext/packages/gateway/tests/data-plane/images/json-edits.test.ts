/**
 * JSON-shaped `/images/edits` normalization.
 *
 * Covers the wire shape Codex's client-owned image extension actually sends
 * (`codex-rs/codex-api/src/images.rs:18-31`), which is JSON with base64 data
 * URLs rather than the multipart form every SDK uses.
 */
import { test, expect } from 'bun:test'
import { formDataFromJsonEdits, parseBase64ImageDataUrl } from '../../../src/data-plane/images/json-edits.ts'

// 1x1 transparent PNG.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/wEAAAAASUVORK5CYII='
const PNG_URL = `data:image/png;base64,${PNG_B64}`

/** The exact body Codex sends: background/quality/size all literal "auto". */
const codexBody = (images: unknown[]) => ({
  images,
  prompt: 'turn the cat into a ragdoll',
  background: 'auto',
  model: 'gpt-image-2',
  quality: 'auto',
  size: 'auto',
})

test('parseBase64ImageDataUrl accepts an image data URL and rejects everything else', () => {
  expect(parseBase64ImageDataUrl(PNG_URL)).toEqual({ mimeType: 'image/png', base64: PNG_B64 })
  expect(parseBase64ImageDataUrl('https://assets.example/image.png')).toBeNull()
  expect(parseBase64ImageDataUrl('data:text/plain;base64,aGk=')).toBeNull()
  expect(parseBase64ImageDataUrl('data:image/png,notbase64')).toBeNull()
})

test('normalizes the Codex edit body into multipart, preserving auto parameters', async () => {
  const result = formDataFromJsonEdits(codexBody([{ image_url: PNG_URL }]))
  if (!result.ok) throw new Error(result.message)

  expect(result.model).toBe('gpt-image-2')
  expect(result.form.get('model')).toBe('gpt-image-2')
  expect(result.form.get('prompt')).toBe('turn the cat into a ragdoll')
  // Upstream resolves these itself (verified: auto → opaque/low/1254x1254),
  // so they must survive verbatim rather than being dropped or defaulted.
  expect(result.form.get('background')).toBe('auto')
  expect(result.form.get('quality')).toBe('auto')
  expect(result.form.get('size')).toBe('auto')

  const image = result.form.get('image')
  expect(image).toBeInstanceOf(File)
  expect((image as File).type).toBe('image/png')
  // 68 bytes is the decoded length of the 1x1 PNG above.
  expect((image as File).size).toBe(68)
  // Structural keys must not leak through as scalar fields.
  expect(result.form.get('images')).toBeNull()
})

test('single image uses `image`, multiple use `image[]`', () => {
  const one = formDataFromJsonEdits(codexBody([{ image_url: PNG_URL }]))
  if (!one.ok) throw new Error(one.message)
  expect(one.form.getAll('image')).toHaveLength(1)
  expect(one.form.getAll('image[]')).toHaveLength(0)

  const two = formDataFromJsonEdits(codexBody([{ image_url: PNG_URL }, { image_url: PNG_URL }]))
  if (!two.ok) throw new Error(two.message)
  expect(two.form.getAll('image[]')).toHaveLength(2)
  expect(two.form.getAll('image')).toHaveLength(0)
})

test('mask is decoded onto its own field', () => {
  const result = formDataFromJsonEdits({ ...codexBody([{ image_url: PNG_URL }]), mask: { image_url: PNG_URL } })
  if (!result.ok) throw new Error(result.message)
  expect(result.form.get('mask')).toBeInstanceOf(File)
})

test('rejects remote image_url with a message that says why', () => {
  const result = formDataFromJsonEdits(codexBody([{ image_url: 'https://assets.example/image.png' }]))
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('expected rejection')
  expect(result.message).toContain('base64 image data URL')
})

test('rejects malformed bodies', () => {
  const cases: [unknown, string][] = [
    [null, 'must be an object'],
    [codexBody([]), 'non-empty images array'],
    [{ ...codexBody([{ image_url: PNG_URL }]), model: '' }, 'model is required'],
    [{ ...codexBody([{ image_url: PNG_URL }]), images: 'nope' }, 'non-empty images array'],
    [codexBody(['nope']), 'must be an object with an image_url'],
    [codexBody([{ file_id: 'file-1' }]), 'must contain a string image_url'],
    [codexBody([{ image_url: 'data:image/png;base64,!!!' }]), 'not valid base64'],
    [{ ...codexBody([{ image_url: PNG_URL }]), extra: { nested: true } }, 'must be a string, number, or boolean'],
  ]
  for (const [body, expected] of cases) {
    const result = formDataFromJsonEdits(body)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error(`expected rejection for ${JSON.stringify(body)}`)
    expect(result.message).toContain(expected)
  }
})

test('numeric and boolean parameters are stringified rather than rejected', () => {
  const result = formDataFromJsonEdits({ ...codexBody([{ image_url: PNG_URL }]), n: 2, stream: false })
  if (!result.ok) throw new Error(result.message)
  expect(result.form.get('n')).toBe('2')
  expect(result.form.get('stream')).toBe('false')
})
