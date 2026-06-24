import { test, expect } from 'bun:test'
import { FakeProvider } from '../src/fake'

test('FakeProvider accepts ProviderRequest', async () => {
  const fp = new FakeProvider({ text: 'hello' })
  const res = await fp.fetch({
    endpoint: 'responses',
    payload: { model: 'fake', input: 'hi' },
    headers: new Headers(),
    sourceApi: 'openai',
    flags: { isStreaming: false },
  })
  expect(res.status).toBe(200)
  expect(res.body).toBeTruthy()
})
