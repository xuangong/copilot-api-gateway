export interface CatalogDraftInputs {
  name?: string
  baseUrl?: string
  apiKey?: string
  endpoint?: string
  azureApiKey?: string
  deployment?: string
  apiVersion?: string
  endpoints?: readonly string[]
  authStyle?: string
  pathOverrides?: Record<string, string>
  modelsEndpoint?: string
  modelsText?: string
  azureDeployments?: string
}

export function catalogDraftIdentity(form: CatalogDraftInputs): string {
  return JSON.stringify([
    form.baseUrl, form.apiKey, form.endpoint, form.azureApiKey,
    form.deployment, form.apiVersion, form.endpoints, form.authStyle,
    form.pathOverrides, form.modelsEndpoint, form.modelsText, form.azureDeployments,
  ])
}

export class CatalogRequestGate {
  private generation = 0
  private upstreamId = ''
  private draftIdentity = ''

  begin(upstreamId: string, draftIdentity: string): number {
    this.upstreamId = upstreamId
    this.draftIdentity = draftIdentity
    return ++this.generation
  }

  accepts(ticket: number, upstreamId: string, draftIdentity: string): boolean {
    return ticket === this.generation && upstreamId === this.upstreamId
      && draftIdentity === this.draftIdentity
  }

  invalidate(): void { this.generation++ }
}
