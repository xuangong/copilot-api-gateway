import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// `text-body` is a font size from our @theme. tailwind-merge only knows the
// default scale, so it would take `text-body` for a colour and let a later
// colour such as `text-fg-muted` drop it.
const twMerge = extendTailwindMerge({ extend: { theme: { text: ["body"] } } })

/** Join class names; on a Tailwind conflict the later class wins. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
