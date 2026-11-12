export function parseLokiModelNames(text: string): string[] {
  return [...new Set(text.split(/[,\r\n]+/).map(id => id.trim()).filter(Boolean))]
}

export function formatLokiModelNames(value: unknown): string {
  return Array.isArray(value) ? value.filter(id => typeof id === "string").join("\n") : ""
}
