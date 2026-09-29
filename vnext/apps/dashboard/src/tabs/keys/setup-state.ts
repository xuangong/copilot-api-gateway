import type { ApiKeyDetail } from "../../api/keys"
import type { SessionInfo } from "../../api/types"
import type { SetupPlatform, SetupSelection, SetupLease, SetupPreview } from "../../api/setup"
export function canSetup(key: Pick<ApiKeyDetail, "owner_id" | "is_owner">, session: SessionInfo | null): boolean {
  return session !== null && (session.isAdmin || key.is_owner && key.owner_id !== null && session.userId !== undefined && String(session.userId) === key.owner_id)
}
export const setupScope = (keyId: string, selection: SetupSelection) => JSON.stringify([keyId, selection])
export function staticSetupCommand(origin: string, platform: SetupPlatform): string {
  const url = new URL(origin)
  if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin) throw new Error("Invalid setup origin")
  if (platform === "windows") {
    const quote = (text: string) => "'" + text.replaceAll("'", "''") + "'"
    return "$p=Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N')+'.ps1'); $result=1; try { Invoke-WebRequest -Uri " + quote(origin + "/setup/setup.ps1") + " -OutFile $p -ErrorAction Stop; $LASTEXITCODE=0; & $p -Origin " + quote(origin) + "; $result=$LASTEXITCODE } catch { Write-Error $_ -ErrorAction Continue } finally { Remove-Item -LiteralPath $p -ErrorAction SilentlyContinue }; if ($result -ne 0) { exit $result }"
  }
  const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'"
  return "(p=$(mktemp) || exit; trap 's=$?; rm -f \"$p\"; exit \"$s\"' EXIT; curl --fail --silent --show-error --output \"$p\" " + quote(origin + "/setup/setup.sh") + " && sh \"$p\" --origin " + quote(origin) + ")"
}
export class SetupRequestGate {
  private generation = 0
  invalidate(): void { this.generation++ }
  begin(): number { return ++this.generation }
  accepts(ticket: number): boolean { return ticket === this.generation }
}

export interface IssuedSetupLease extends SetupLease { scope: string; selection: SetupSelection; preview: SetupPreview }
export function bindMintedLease(scope: string, selection: SetupSelection, preview: SetupPreview, lease: SetupLease): IssuedSetupLease {
  return { ...lease, scope, selection: structuredClone(selection), preview: structuredClone(preview) }
}
