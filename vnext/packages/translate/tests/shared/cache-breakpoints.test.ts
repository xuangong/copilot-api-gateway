import { describe, it, expect } from 'bun:test'
import {
  EPHEMERAL_CACHE_CONTROL,
  applyLastToolCacheBreakpoint,
  applyLastMessageCacheBreakpoint,
  systemWithCacheBreakpoint,
} from '@vnext/translate/shared/cache-breakpoints'

describe('cache-breakpoints', () => {
  describe('systemWithCacheBreakpoint', () => {
    it('returns undefined when text is empty/undefined', () => {
      expect(systemWithCacheBreakpoint(undefined)).toBeUndefined()
      expect(systemWithCacheBreakpoint('')).toBeUndefined()
    })

    it('wraps text into a single text block with ephemeral cache_control', () => {
      const out = systemWithCacheBreakpoint('hello system')
      expect(out).toEqual([
        { type: 'text', text: 'hello system', cache_control: EPHEMERAL_CACHE_CONTROL },
      ])
    })
  })

  describe('applyLastToolCacheBreakpoint', () => {
    it('no-op on undefined / empty', () => {
      applyLastToolCacheBreakpoint(undefined)
      const empty: Array<{ name: string }> = []
      applyLastToolCacheBreakpoint(empty)
      expect(empty).toEqual([])
    })

    it('marks last custom tool with ephemeral cache_control', () => {
      const tools = [
        { name: 'a' },
        { name: 'b' },
        { name: 'c' },
      ]
      applyLastToolCacheBreakpoint(tools)
      expect((tools[2] as { cache_control?: unknown }).cache_control).toEqual(EPHEMERAL_CACHE_CONTROL)
      expect((tools[1] as { cache_control?: unknown }).cache_control).toBeUndefined()
    })

    it('skips server-side tools (web_search_*, computer_*) when picking the breakpoint', () => {
      const tools = [
        { name: 'custom1' },
        { name: 'web_search_20250305', type: 'web_search_20250305' },
        { name: 'computer_20250124', type: 'computer_20250124' },
      ]
      applyLastToolCacheBreakpoint(tools)
      expect((tools[0] as { cache_control?: unknown }).cache_control).toEqual(EPHEMERAL_CACHE_CONTROL)
      expect((tools[1] as { cache_control?: unknown }).cache_control).toBeUndefined()
      expect((tools[2] as { cache_control?: unknown }).cache_control).toBeUndefined()
    })

    it('marks tools with explicit type "custom"', () => {
      const tools = [
        { name: 'a', type: 'custom' as const },
      ]
      applyLastToolCacheBreakpoint(tools)
      expect((tools[0] as { cache_control?: unknown }).cache_control).toEqual(EPHEMERAL_CACHE_CONTROL)
    })

    it('does nothing when only server-side tools are present', () => {
      const tools = [
        { name: 'web_search_x', type: 'web_search_20250305' },
      ]
      applyLastToolCacheBreakpoint(tools)
      expect((tools[0] as { cache_control?: unknown }).cache_control).toBeUndefined()
    })
  })

  describe('applyLastMessageCacheBreakpoint', () => {
    it('promotes string content into a single text block with cache_control', () => {
      const messages = [
        { role: 'user' as const, content: 'hello' },
      ]
      applyLastMessageCacheBreakpoint(messages)
      expect(messages[0]?.content).toEqual([
        { type: 'text', text: 'hello', cache_control: EPHEMERAL_CACHE_CONTROL },
      ])
    })

    it('marks last cacheable block in last message', () => {
      const messages = [
        { role: 'user' as const, content: [{ type: 'text', text: 'old' }] },
        { role: 'assistant' as const, content: [
          { type: 'text', text: 'a' },
          { type: 'tool_use', id: 'id1', name: 'tool', input: {} },
        ] },
      ]
      applyLastMessageCacheBreakpoint(messages)
      const blocks = messages[1]?.content as Array<{ type: string; cache_control?: unknown }>
      expect(blocks[0]?.cache_control).toBeUndefined()
      expect(blocks[1]?.cache_control).toEqual(EPHEMERAL_CACHE_CONTROL)
    })

    it('marks last cacheable block (text) when last block is non-cacheable like thinking', () => {
      const messages = [
        { role: 'assistant' as const, content: [
          { type: 'text', text: 'reply' },
          { type: 'thinking', thinking: 'r' },
        ] },
      ]
      applyLastMessageCacheBreakpoint(messages)
      const blocks = messages[0]?.content as Array<{ type: string; cache_control?: unknown }>
      expect(blocks[0]?.cache_control).toEqual(EPHEMERAL_CACHE_CONTROL)
      expect(blocks[1]?.cache_control).toBeUndefined()
    })

    it('falls through to earlier message when last has only non-cacheable blocks', () => {
      const messages = [
        { role: 'user' as const, content: [{ type: 'text', text: 'first' }] },
        { role: 'assistant' as const, content: [{ type: 'thinking', thinking: 'r' }] },
      ]
      applyLastMessageCacheBreakpoint(messages)
      const earlier = messages[0]?.content as Array<{ type: string; cache_control?: unknown }>
      expect(earlier[0]?.cache_control).toEqual(EPHEMERAL_CACHE_CONTROL)
    })
  })
})
