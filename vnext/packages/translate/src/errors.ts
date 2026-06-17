export class TranslatorValidationError extends Error {
  readonly kind = 'translator-validation' as const
  constructor(message: string, public readonly field?: string) {
    super(message)
    this.name = 'TranslatorValidationError'
  }
}
