import { TranslatorValidationError } from "../../errors.ts"

export function customToolParameters() {
  return {
    type: "object",
    properties: { input: { type: "string" } },
    required: ["input"],
    additionalProperties: false,
  } as const
}

export function wrapCustomInput(input: string): string {
  return JSON.stringify({ input })
}

export function unwrapCustomInput(value: unknown): string {
  let parsed: unknown = value
  if (typeof value === "string") {
    try { parsed = JSON.parse(value) as unknown } catch {
      throw new TranslatorValidationError("Custom tool arguments must be a JSON object with string input", "output")
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TranslatorValidationError("Custom tool arguments must be a JSON object with string input", "output")
  }
  const object = parsed as Record<string, unknown>
  if (typeof object.input !== "string" || Object.keys(object).some(key => key !== "input")) {
    throw new TranslatorValidationError("Custom tool arguments must contain only string input", "output")
  }
  return object.input
}
