import type { SearchResult } from "./types"

export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) {
    return "No search results found."
  }

  return results
    .map(
      (result, index) =>
        `[${index + 1}] ${result.title}\nURL: ${result.url}\n${result.snippet}`,
    )
    .join("\n\n")
}
