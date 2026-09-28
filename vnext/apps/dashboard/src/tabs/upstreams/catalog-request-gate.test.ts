import { expect, test } from 'bun:test'
import { CatalogRequestGate, catalogDraftIdentity } from './catalog-request-gate'

test('a late response from an edited draft or switched upstream cannot replace the current catalog', () => {
  const gate = new CatalogRequestGate()
  const first = gate.begin('up_a', 'draft_a')
  expect(gate.accepts(first, 'up_a', 'draft_a')).toBe(true)
  expect(gate.accepts(first, 'up_a', 'draft_b')).toBe(false)
  expect(gate.accepts(first, 'up_b', 'draft_a')).toBe(false)
  gate.invalidate()
  expect(gate.accepts(first, 'up_a', 'draft_a')).toBe(false)
  const second = gate.begin('up_b', 'draft_b')
  expect(gate.accepts(second, 'up_b', 'draft_b')).toBe(true)
})

test('catalog draft identity changes only for discovery inputs', () => {
  const form = { name: 'A', baseUrl: 'https://a', apiKey: '', modelsText: '', endpoints: ['responses'] }
  expect(catalogDraftIdentity({ ...form, name: 'B' })).toBe(catalogDraftIdentity(form))
  expect(catalogDraftIdentity({ ...form, baseUrl: 'https://b' })).not.toBe(catalogDraftIdentity(form))
  expect(catalogDraftIdentity({ ...form, modelsText: 'new-model' })).not.toBe(catalogDraftIdentity(form))
})
