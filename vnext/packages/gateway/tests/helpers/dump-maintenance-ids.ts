import type { ApiKeyId, DumpRecordId } from "../../src/repo/branded-ids.ts"

// Test fixture boundary: production receives branded IDs from repository rows.
export const repoId = (value: string): ApiKeyId => value as ApiKeyId
export const dumpId = (value: string): DumpRecordId => value as DumpRecordId
