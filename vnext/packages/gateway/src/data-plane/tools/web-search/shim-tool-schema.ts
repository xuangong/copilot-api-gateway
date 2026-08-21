/**
 * The function-tool surface every web-search shim exposes to the orchestrator
 * model, independent of which protocol the shim lives on.
 *
 * The shape is OpenAI's `web.run` tool: 13 sub-properties on a single tool, of
 * which the gateway implements three (`search_query`, `open`, `find`). The
 * other ten surface as per-entry error IRs at dispatch time, so the
 * description deliberately omits them.
 *   https://github.com/openai/harmony/blob/abd677f7ac962629c808197caa1feb9e3e95d2b0/src/chat.rs#L259-L313
 *
 * Both the Responses server-tool plugin and the Chat Completions interceptor
 * build their protocol-native tool envelope around these two constants, so a
 * model that has learned the sub-property vocabulary on one endpoint behaves
 * identically on the other. Only the envelope differs: Responses puts `name`
 * and `parameters` at the top level, Chat Completions nests them under
 * `function`.
 */

// Function-name regex `^[a-zA-Z0-9_-]+$` forbids dots, so the shim call uses
// the underscored form of the model's training-time `web.run`.
export const WEB_SEARCH_SHIM_TOOL_NAME = 'web_search'

export const WEB_SEARCH_SHIM_TOOL_DESCRIPTION
  = 'Accesses the web through three actions: searching, opening a page, and finding text inside a page. '
  + 'Multiple sub-property arrays may be populated in one call to dispatch several operations in parallel.'

export const WEB_SEARCH_SHIM_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {
    search_query: {
      type: 'array',
      description: 'Run one or more web searches. Each entry produces an independent search-results list.',
      items: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'The search query.' },
        },
        required: ['q'],
        additionalProperties: false,
      },
    },
    open: {
      type: 'array',
      description: 'Fetch the readable text content of fully qualified URLs.',
      items: {
        type: 'object',
        properties: {
          ref_id: { type: 'string', description: 'An HTTP or HTTPS URL.' },
        },
        required: ['ref_id'],
        additionalProperties: false,
      },
    },
    find: {
      type: 'array',
      description: 'Find exact case-insensitive matches of `pattern` inside the page at `ref_id`. Returns up to 10 matches with ~200 characters of surrounding context.',
      items: {
        type: 'object',
        properties: {
          ref_id: { type: 'string', description: 'An HTTP or HTTPS URL of the page to search inside.' },
          pattern: { type: 'string', description: 'Case-insensitive substring to find.' },
        },
        required: ['ref_id', 'pattern'],
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
}
