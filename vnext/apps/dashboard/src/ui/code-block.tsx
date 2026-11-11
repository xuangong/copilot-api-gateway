import { Check, Copy } from "lucide-react"
import { Button } from "./button"
import { cn } from "./cn"

interface Props {
  language: string
  text: string
  copyLabel: string
  copied: boolean
  onCopy: () => void | Promise<void>
  className?: string
}

export function CodeBlock({ language, text, copyLabel, copied, onCopy, className }: Props) {
  return (
    <div className={cn("relative", className)}>
      <pre className="overflow-x-auto whitespace-pre rounded-lg border border-border bg-muted p-3 pr-11 font-mono text-xs leading-relaxed text-fg">
        <code className={`language-${language}`}>{text}</code>
      </pre>
      <Button
        variant="ghost"
        size="icon-sm"
        className="absolute top-1.5 right-1.5"
        aria-label={copyLabel}
        title={copyLabel}
        onClick={() => void onCopy()}
      >
        {copied ? <Check className="text-success" /> : <Copy />}
      </Button>
    </div>
  )
}
