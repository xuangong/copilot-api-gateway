import { describe, it, expect } from 'bun:test'
import {
  packReasoningSignature,
  unpackReasoningSignature,
  responsesReasoningToMessagesBlock,
} from '@vnext-llm/translate/shared/reasoning-pack'

describe('reasoning-pack', () => {
  describe('packReasoningSignature', () => {
    it('packs encrypted + id as `${encrypted}@${id}`', () => {
      expect(packReasoningSignature('rs_123', 'enc-data')).toBe('enc-data@rs_123')
    })

    it('returns just the encrypted when id is empty/undefined', () => {
      expect(packReasoningSignature(undefined, 'enc-data')).toBe('enc-data')
      expect(packReasoningSignature('', 'enc-data')).toBe('enc-data')
    })

    it('returns just the id (with leading @) when encrypted is empty/undefined', () => {
      expect(packReasoningSignature('rs_xyz', undefined)).toBe('@rs_xyz')
      expect(packReasoningSignature('rs_xyz', '')).toBe('@rs_xyz')
    })

    it('returns empty when both are missing', () => {
      expect(packReasoningSignature(undefined, undefined)).toBe('')
    })
  })

  describe('unpackReasoningSignature', () => {
    it('parses `${encrypted}@${id}` back to its parts', () => {
      expect(unpackReasoningSignature('enc-data@rs_123')).toEqual({
        encrypted: 'enc-data',
        id: 'rs_123',
      })
    })

    it('returns only encrypted when no @id is present', () => {
      expect(unpackReasoningSignature('enc-data')).toEqual({
        encrypted: 'enc-data',
        id: undefined,
      })
    })

    it('returns only id when input begins with @', () => {
      expect(unpackReasoningSignature('@rs_xyz')).toEqual({
        encrypted: undefined,
        id: 'rs_xyz',
      })
    })

    it('handles empty string', () => {
      expect(unpackReasoningSignature('')).toEqual({
        encrypted: undefined,
        id: undefined,
      })
    })

    it('round-trips with packReasoningSignature', () => {
      const cases: Array<[string | undefined, string | undefined]> = [
        ['rs_1', 'enc'],
        [undefined, 'enc'],
        ['rs_2', undefined],
      ]
      for (const [id, encrypted] of cases) {
        const packed = packReasoningSignature(id, encrypted)
        const unpacked = unpackReasoningSignature(packed)
        expect(unpacked).toEqual({ id, encrypted })
      }
    })

    it('keeps the last @ as the separator (id may not contain @, encrypted may)', () => {
      // base64-style encrypted strings don't include @, but if they do we
      // split at the last @ so the id (an opaque token) stays intact.
      expect(unpackReasoningSignature('a@b@rs_z')).toEqual({
        encrypted: 'a@b',
        id: 'rs_z',
      })
    })
  })

  describe('responsesReasoningToMessagesBlock', () => {
    it('emits a thinking block when summary text is non-empty', () => {
      const out = responsesReasoningToMessagesBlock({
        id: 'rs_001',
        summary: [{ type: 'summary_text', text: 'thinking words' }],
        encrypted_content: 'enc-z',
      })
      expect(out).toEqual({
        type: 'thinking',
        thinking: 'thinking words',
        signature: 'enc-z@rs_001',
      })
    })

    it('emits a redacted_thinking block when summary is empty', () => {
      const out = responsesReasoningToMessagesBlock({
        id: 'rs_002',
        summary: [],
        encrypted_content: 'enc-z',
      })
      expect(out).toEqual({
        type: 'redacted_thinking',
        data: 'enc-z@rs_002',
      })
    })

    it('emits a redacted_thinking block when summary is missing', () => {
      const out = responsesReasoningToMessagesBlock({
        id: 'rs_003',
        encrypted_content: 'enc',
      })
      expect(out).toEqual({
        type: 'redacted_thinking',
        data: 'enc@rs_003',
      })
    })

    it('joins multi-part summary with newlines', () => {
      const out = responsesReasoningToMessagesBlock({
        id: 'rs_004',
        summary: [
          { type: 'summary_text', text: 'first paragraph' },
          { type: 'summary_text', text: 'second paragraph' },
        ],
        encrypted_content: 'enc',
      })
      expect(out).toEqual({
        type: 'thinking',
        thinking: 'first paragraph\nsecond paragraph',
        signature: 'enc@rs_004',
      })
    })

    it('omits signature/data when no encrypted_content nor id', () => {
      const out = responsesReasoningToMessagesBlock({
        summary: [{ type: 'summary_text', text: 'hi' }],
      })
      // signature is optional in the hub schema; falsy join must not produce '@'
      if (out.type === 'thinking') {
        expect(out.signature ?? '').toBe('')
      }
    })
  })
})
