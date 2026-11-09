// Raw-number JSON helpers, ported from the reference
// (`packages/protocols/src/common/json.ts`). A decision answer's probabilities
// must survive a round trip byte for byte: a parsed JavaScript number would
// re-serialize `1.0` as `1` and a value beyond the double range as `null`.

// Preserve every number token that the parsed JavaScript value would not serialize identically.
// https://tc39.es/proposal-json-parse-with-source/#sec-json.rawjson
const jsonWithRawNumbers = JSON as typeof JSON & {
  rawJSON: (text: string) => { readonly rawJSON: string }
}

// A number token preserved from the parsed text, for values a JavaScript number
// would not serialize back identically. `JSON.stringify` renders it verbatim.
export type JsonNumber = number | { readonly rawJSON: string }

const jsonWithRawCheck = JSON as typeof JSON & { isRawJSON?: (value: unknown) => boolean }

export const isRawNumber = (value: unknown): boolean => jsonWithRawCheck.isRawJSON?.(value) === true

// Read a numeric answer field, keeping an exact source token when the parser
// preserved one and rejecting anything that is not a finite number.
// The token is returned as-is: a rebuilt `{ rawJSON }` object loses the
// intrinsic `JSON.rawJSON` identity and serializes as a plain object.
export const parseJsonNumber = (value: unknown, field: string): JsonNumber => {
  if (isRawNumber(value)) {
    if (!Number.isFinite(Number((value as { rawJSON: string }).rawJSON))) throw new Error(`${field} must be a finite number`)
    return value as JsonNumber
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} must be a finite number`)
  return value
}

export const parseJSONWithRawNumbers = (text: string): unknown => JSON.parse(text, (_key: string, value: unknown, context?: { source: string }) => {
  if (typeof value === 'number' && JSON.stringify(value) !== context!.source) return jsonWithRawNumbers.rawJSON(context!.source)
  return value
})
