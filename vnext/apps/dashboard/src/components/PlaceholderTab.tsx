interface Props {
  title: string
  note?: string
}

export function PlaceholderTab({ title, note }: Props) {
  return (
    <div className="glass-card p-12 text-center animate-in">
      <div className="text-xl text-themed font-medium">{title}</div>
      <div className="mt-2 text-sm text-themed-dim">{note ?? "TODO: migrate from Alpine version"}</div>
    </div>
  )
}
