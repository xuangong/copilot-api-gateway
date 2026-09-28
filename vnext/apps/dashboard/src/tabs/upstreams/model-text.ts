const validEntry = (entry: unknown): boolean => {
  if (typeof entry === "string") return entry.trim().length > 0
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false
  const record = entry as Record<string, unknown>
  const id = record.id ?? record.upstreamModelId
  return typeof id === "string" && id.trim().length > 0
}

export const formatModelsText = (models: unknown): string => {
  if (!Array.isArray(models) || models.length === 0) return ""
  // The line notation cannot represent metadata or IDs containing its delimiters.
  if (models.every((entry: unknown) => typeof entry === "string"
    && entry === entry.trim() && !/[#\r\n]/.test(entry) && !entry.startsWith("["))) {
    return models.join("\n")
  }
  return JSON.stringify(models, null, 2)
}

export const parseModelsText = (text: string): unknown[] | undefined => {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  if (trimmed.startsWith("[")) {
    const entries: unknown = JSON.parse(trimmed)
    if (!Array.isArray(entries) || !entries.every(validEntry)) {
      throw new Error("Models must be strings or objects with a non-empty id or upstreamModelId")
    }
    return entries
  }
  const entries = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const hash = line.indexOf("#")
    return hash < 0 ? line : { id: line.slice(0, hash).trim(), name: line.slice(hash + 1).trim() }
  })
  if (!entries.every(validEntry)) throw new Error("Model IDs must not be empty")
  return entries
}
