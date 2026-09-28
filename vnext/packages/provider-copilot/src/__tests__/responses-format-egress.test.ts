import { expect, test } from 'bun:test'
import { CopilotProvider } from '../provider'
import { clearRawModelsCache } from '../raw-models-cache'

for (const reasoningEffort of [false, true]) {
  for (const translated of [false, true]) {
    test(`actual Copilot chain ${reasoningEffort ? 'format strip' : 'output_config removal'}; translated=${translated}`, async () => {
      clearRawModelsCache()
      let inferenceCalls = 0
      const provider = new CopilotProvider({ copilotToken: `a15-${reasoningEffort}-${translated}`, accountType: 'individual' }, async (url) => {
        if (url.endsWith('/models')) return Response.json({ data: [{ id: 'claude-format-test', capabilities: { supports: reasoningEffort ? { reasoning_effort: ['high'] } : {} } }] })
        inferenceCalls++
        return Response.json({ id: 'msg', type: 'message', content: [] })
      })
      const result = await provider.fetch({
        endpoint: 'messages', sourceApi: 'anthropic', sourceProtocol: translated ? 'responses' : 'messages', headers: new Headers(),
        payload: { model: 'claude-format-test', messages: [], max_tokens: 10, output_config: { effort: 'high', format: { type: 'json_schema', schema: { type: 'object' } } } },
      })
      expect(result.status).toBe(translated ? 400 : 200)
      expect(inferenceCalls).toBe(translated ? 0 : 1)
      if (translated) expect(await new Response(result.body).json()).toMatchObject({ error: { param: 'text.format' } })
    })
  }
}
