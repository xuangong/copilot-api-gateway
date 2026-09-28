import { TranslatorValidationError } from '../errors'

type ObjectValue = Record<string, unknown>
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value)
const reject = (field: string, message: string): never => { throw new TranslatorValidationError(`${field}: ${message}`, field) }

function readFormat(payload: ObjectValue): ObjectValue | undefined {
  if (payload.text === undefined) return undefined
  if (!object(payload.text)) return reject('text', 'expected an object')
  const format = payload.text.format
  if (format === undefined) return undefined
  if (!object(format)) return reject('text.format', 'expected an object')
  if (typeof format.type !== 'string' || !['text', 'json_object', 'json_schema'].includes(format.type)) return reject('text.format.type', 'unsupported format type')
  const keys = format.type === 'json_schema' ? ['type', 'name', 'schema', 'description', 'strict'] : ['type']
  for (const key of Object.keys(format)) {
    if (!keys.includes(key)) reject(`text.format.${key}`, 'unsupported format field')
  }
  if (format.type === 'json_schema') {
    if (typeof format.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(format.name)) reject('text.format.name', 'expected 1–64 ASCII letters, digits, underscores or hyphens')
    if (!object(format.schema)) reject('text.format.schema', 'expected a JSON schema object')
    if (format.description !== undefined && typeof format.description !== 'string') reject('text.format.description', 'expected a string')
    if (format.strict !== undefined && typeof format.strict !== 'boolean') reject('text.format.strict', 'expected a boolean')
  }
  return format
}

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, i) => equal(value, b[i]))
  if (!object(a) || !object(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]))
}

export function projectResponsesTextFormat(payload: ObjectValue, target: 'chat' | 'messages'): ObjectValue | undefined {
  const format = readFormat(payload)
  let projected: ObjectValue | undefined
  if (format?.type === 'json_schema') {
    if (target === 'messages') {
      if (format.description !== undefined) reject('text.format.description', 'Messages has no equivalent description constraint')
      if (format.strict !== true) reject('text.format.strict', 'Messages requires explicit strict schema adherence')
      // Responses name identifies the format; Messages has no metadata slot.
      projected = { type: 'json_schema', schema: structuredClone(format.schema) }
    } else {
      const { type, ...jsonSchema } = format
      projected = { type, json_schema: structuredClone(jsonSchema) }
    }
  } else if (format?.type === 'json_object') {
    if (target === 'messages') reject('text.format.type', 'Messages has no JSON object mode')
    projected = { type: 'json_object' }
  }
  const extension = target === 'chat' ? payload.response_format : object(payload.output_config) ? payload.output_config.format : undefined
  const field = target === 'chat' ? 'response_format' : 'output_config.format'
  if (extension !== undefined && !equal(extension, projected ?? (target === 'chat' ? { type: 'text' } : undefined))) {
    reject(field, 'conflicts with text.format; use the Responses source field')
  }
  return projected
}

export function responsesOutputConfig(payload: ObjectValue): ObjectValue {
  if (payload.output_config === undefined) return {}
  if (!object(payload.output_config)) return reject('output_config', 'expected an object')
  return structuredClone(payload.output_config)
}
