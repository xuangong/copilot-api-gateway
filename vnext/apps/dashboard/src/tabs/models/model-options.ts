import type { PlaygroundModel } from "../../api/models"
import type { SelectOption } from "../../components/Select"

export function playgroundModelOptions(models: PlaygroundModel[], mappedBadge: string): SelectOption[] {
  return [...models]
    .sort((a, b) => a._upstream.localeCompare(b._upstream) || a.id.localeCompare(b.id))
    .map((model) => ({
      value: model.id,
      label: model._mapped_to ? model.id : model.name ?? model.id,
      ...(model._mapped_to ? { badge: mappedBadge } : {}),
    }))
}
