import { test, expect } from 'bun:test'
import { serializeOpenAIImagesEditsRequest } from '../src/images'

test('serializeOpenAIImagesEditsRequest preserves reference fields and encodes mixed uploads from their bytes', async () => {
  const serialized = await serializeOpenAIImagesEditsRequest({
    images: [
      { type: 'reference', reference: { image_url: 'https://example.test/image.png', detail: 'future-field' } },
      { type: 'upload', file: new File(['inline'], 'inline.png', { type: 'image/png' }) },
    ],
    mask: { type: 'reference', reference: { file_id: 'file-mask' } },
    parameters: { prompt: 'edit', background: null },
  }, 'gpt-image')
  expect(typeof serialized).toBe('string')
  const body = JSON.parse(serialized as string) as Record<string, unknown>
  expect(body).toEqual({
    prompt: 'edit',
    background: null,
    images: [
      { image_url: 'https://example.test/image.png', detail: 'future-field' },
      { image_url: 'data:image/png;base64,aW5saW5l' },
    ],
    mask: { file_id: 'file-mask' },
    model: 'gpt-image',
  })
})

test('serializeOpenAIImagesEditsRequest uses the singular field for one upload and the array field for many', async () => {
  const first = new File(['first'], 'first.png', { type: 'image/png' })
  const second = new File(['second'], 'second.png', { type: 'image/png' })
  const single = await serializeOpenAIImagesEditsRequest({
    images: [{ type: 'upload', file: first }],
    parameters: { prompt: 'single' },
  }, 'gpt-image')
  expect(single instanceof FormData).toBe(true)
  const singleForm = single as FormData
  const singleImage = singleForm.get('image') as File
  expect(singleImage).not.toBeNull()
  expect(singleImage.name).toBe('first.png')
  expect(singleForm.getAll('image[]')).toEqual([])

  const multiple = await serializeOpenAIImagesEditsRequest({
    images: [{ type: 'upload', file: first }, { type: 'upload', file: second }],
    parameters: { prompt: 'multiple' },
  }, 'gpt-image')
  expect(multiple instanceof FormData).toBe(true)
  const multipleForm = multiple as FormData
  const arr = multipleForm.getAll('image[]') as File[]
  expect(arr.map(f => f.name)).toEqual(['first.png', 'second.png'])
  expect(multipleForm.get('image')).toBeNull()
  expect(multipleForm.get('model')).toBe('gpt-image')
})

test('serializeOpenAIImagesEditsRequest leaves malformed inline data for upstream JSON validation', async () => {
  const serialized = await serializeOpenAIImagesEditsRequest({
    images: [{
      type: 'inline',
      reference: { image_url: 'data:image/png;base64,%%%' },
    }],
    parameters: { prompt: 'edit' },
  }, 'gpt-image')
  expect(typeof serialized).toBe('string')
  expect(JSON.parse(serialized as string)).toEqual({
    prompt: 'edit',
    images: [{ image_url: 'data:image/png;base64,%%%' }],
    model: 'gpt-image',
  })
})

test('serializeOpenAIImagesEditsRequest preserves extra inline reference fields through JSON', async () => {
  const serialized = await serializeOpenAIImagesEditsRequest({
    images: [{
      type: 'inline',
      reference: { image_url: 'data:image/png;base64,aW1hZ2U=', future_field: 'keep' },
    }],
    parameters: { prompt: 'edit' },
  }, 'gpt-image')
  expect(typeof serialized).toBe('string')
  expect(JSON.parse(serialized as string)).toEqual({
    prompt: 'edit',
    images: [{ image_url: 'data:image/png;base64,aW1hZ2U=', future_field: 'keep' }],
    model: 'gpt-image',
  })
})
