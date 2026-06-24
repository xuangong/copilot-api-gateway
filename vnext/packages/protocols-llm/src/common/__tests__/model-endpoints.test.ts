import { test, expect } from 'bun:test'
import { kindForEndpoints, type ModelEndpoints } from '../model-endpoints'

test('embeddings only → embedding', () => {
  expect(kindForEndpoints({ embeddings: {} })).toBe('embedding')
})

test('images_generations only → image', () => {
  expect(kindForEndpoints({ images_generations: {} })).toBe('image')
})

test('images_edits only → image', () => {
  expect(kindForEndpoints({ images_edits: {} })).toBe('image')
})

test('both image endpoints → image', () => {
  expect(kindForEndpoints({ images_generations: {}, images_edits: {} })).toBe('image')
})

test('chat_completions only → chat', () => {
  expect(kindForEndpoints({ chat_completions: {} })).toBe('chat')
})

test('messages + responses + chat_completions → chat', () => {
  expect(kindForEndpoints({
    messages: {}, responses: {}, chat_completions: {},
  })).toBe('chat')
})

test('embeddings + chat_completions (mixed) → chat', () => {
  // Mixed embedding + chat is a violation of the invariant but the function
  // must not blow up. Producer-side validation will catch it.
  expect(kindForEndpoints({ embeddings: {}, chat_completions: {} } as ModelEndpoints))
    .toBe('chat')
})

test('empty object → chat (defensive default)', () => {
  expect(kindForEndpoints({})).toBe('chat')
})
