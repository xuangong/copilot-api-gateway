// Ported from copilot-gateway packages/protocols/src/responses/item-id.ts.
//
// These are only the Responses item types Floway itself can create, not a
// catalog or validator for provider-returned item IDs.
// OpenAI's wire examples use msg_/rs_/ws_/ctc_ for their corresponding item
// lifecycles and fc_/cmp_ for function and compaction items.
const generatedItemPrefixes = {
  message: 'msg',
  reasoning: 'rs',
  web_search_call: 'ws',
  function_call: 'fc',
  custom_tool_call: 'ctc',
  compaction: 'cmp',
  image_generation_call: 'ig',
} as const

export type GeneratedResponsesItemType = keyof typeof generatedItemPrefixes

export const createRandomResponsesItemId = (type: GeneratedResponsesItemType): string => {
  if (!Object.hasOwn(generatedItemPrefixes, type)) {
    throw new TypeError(`Unknown generated Responses item type: ${type as string}`)
  }
  const prefix = generatedItemPrefixes[type]
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return `${prefix}_${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}
