import { test, expect, beforeEach } from 'bun:test'
import {
  registerServerToolPlugin,
  listServerToolPlugins,
  getServerToolPlugin,
  _resetServerToolRegistry,
} from '../src/data-plane/orchestrator/server-tools/registry.ts'
import type { ServerToolPlugin } from '../src/data-plane/orchestrator/server-tools/types.ts'

beforeEach(() => { _resetServerToolRegistry() })

const stub = (name: string): ServerToolPlugin<unknown, unknown> => ({
  name,
  register: async () => ({ type: 'inactive' }),
})

test('register + list + get round-trip', () => {
  registerServerToolPlugin(stub('web_search'))
  registerServerToolPlugin(stub('image_generation'))
  expect(listServerToolPlugins().map((p) => p.name).sort()).toEqual(['image_generation', 'web_search'])
  expect(getServerToolPlugin('web_search')?.name).toBe('web_search')
  expect(getServerToolPlugin('missing')).toBeUndefined()
})

test('duplicate registration throws', () => {
  registerServerToolPlugin(stub('web_search'))
  expect(() => registerServerToolPlugin(stub('web_search'))).toThrow(/already registered/)
})
