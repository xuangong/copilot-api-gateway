import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

/** Join class names; on a Tailwind conflict the later class wins. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
