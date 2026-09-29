export interface CodexImportTicket {
  generation: number
  document: string
  targetId: string | null
}

// The document stays in this modal-owned object only. A changed document,
// target, or newer request invalidates every older async completion.
export class CodexImportDraft {
  private generation = 0
  private rawDocument = ""
  private targetId: string | null

  constructor(targetId: string | null) { this.targetId = targetId }

  get document(): string { return this.rawDocument }

  setDocument(document: string): void {
    this.rawDocument = document
    this.generation++
  }

  setTarget(targetId: string | null): void {
    if (this.targetId === targetId) return
    this.targetId = targetId
    this.clear()
  }

  begin(): CodexImportTicket {
    return { generation: ++this.generation, document: this.rawDocument, targetId: this.targetId }
  }

  accepts(ticket: CodexImportTicket): boolean {
    return this.generation === ticket.generation && this.rawDocument === ticket.document && this.targetId === ticket.targetId
  }

  clear(): void {
    this.rawDocument = ""
    this.generation++
  }
}
