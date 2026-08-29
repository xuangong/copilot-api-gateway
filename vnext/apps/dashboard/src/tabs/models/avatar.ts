/**
 * The label on an assistant turn's avatar.
 *
 * A generic "AI" badge on every reply tells the reader nothing, and the
 * playground's whole point is comparing models — a thread can hold answers
 * from three of them. So each turn wears the name of the model that wrote it.
 *
 * The full name doesn't fit a badge, and the leading word is the part that
 * identifies the family anyway: "Claude Opus 5" → Claude, "GPT-5.5" → GPT,
 * "MAI-Code-1-Flash" → MAI. Everything after it is a version or a variant,
 * which the topbar already shows in full.
 */

/** Longest label a badge shows before it starts crowding the bubble. */
const MAX_LABEL = 10

/** Shown for history persisted before turns recorded their model. */
export const FALLBACK_AVATAR = "AI"

/**
 * Leading word of a model name. "Word" ends at the first separator — space,
 * hyphen, underscore, dot, slash, colon — or at the first digit, so a name
 * written without a separator ("GPT4o") still yields the family.
 */
export function avatarLabel(modelName: string | undefined): string {
  if (!modelName) return FALLBACK_AVATAR
  // Vendor-prefixed ids ("openai/gpt-5.5", "copilot:claude-opus-5") name the
  // route, not the model; the part after the last separator is the model.
  const tail = modelName.trim().split(/[/:]/).pop() ?? ""
  const head = /^[A-Za-z]+/.exec(tail)?.[0] ?? ""
  // Casing is taken as given rather than normalised: the catalog's display
  // names are already written the way each vendor writes them ("GPT", "Grok",
  // "MAI"), and no rule guesses right for both "gpt" → GPT and "grok" → Grok.
  return head ? head.slice(0, MAX_LABEL) : FALLBACK_AVATAR
}
