import { z } from 'zod'

const Part = z.union([
  z.object({ text: z.string() }).loose(),
  z.object({ inlineData: z.object({ mimeType: z.string(), data: z.string() }).loose() }).loose(),
  z.object({ functionCall: z.object({ name: z.string(), args: z.unknown().optional() }).loose() }).loose(),
  z.object({ functionResponse: z.object({ name: z.string(), response: z.unknown() }).loose() }).loose(),
  z.object({ thought: z.boolean().optional() }).loose(),
])

const Content = z.object({
  role: z.union([z.literal('user'), z.literal('model'), z.literal('function')]).optional(),
  parts: z.array(Part),
}).loose()

const FunctionDeclaration = z.object({
  name: z.string(),
  description: z.string().optional(),
  parameters: z.unknown().optional(),
}).loose()

const Tool = z.object({
  functionDeclarations: z.array(FunctionDeclaration).optional(),
  googleSearch: z.unknown().optional(),
  codeExecution: z.unknown().optional(),
}).loose()

export const GeminiPayloadSchema = z.object({
  contents: z.array(Content),
  systemInstruction: z.union([Content, z.object({ parts: z.array(Part) }).loose()]).optional(),
  generationConfig: z.unknown().optional(),
  safetySettings: z.array(z.unknown()).optional(),
  tools: z.array(Tool).optional(),
  toolConfig: z.unknown().optional(),
}).loose()

export type GeminiPayload = z.infer<typeof GeminiPayloadSchema>
