param([Parameter(Mandatory=$true)][string]$Origin)
Set-PSDebug -Off
$ErrorActionPreference = 'Stop'
$bun = Get-Command bun -CommandType Application -ErrorAction SilentlyContinue
if (-not $bun) { throw 'Bun must already be installed; no lease was consumed.' }
& $bun.Source -e 'const p=require("node:path"); const f=require("node:fs"); const h=f.realpathSync(require("node:os").homedir()); for(const [k,d] of [["CODEX_HOME",".codex"],["CLAUDE_CONFIG_DIR",".claude"]]) if(process.env[k] && p.resolve(process.env[k])!==p.join(h,d) && p.resolve(process.env[k])!==p.join(require("node:os").homedir(),d)) {process.stderr.write("Custom configuration home unsupported; no lease was consumed\n");process.exit(1)}; const s=process.argv[1]; const u=new URL(s); if(!/^https?:\/\/[^/?#\\@\s]+$/.test(s)||u.origin!==s) {process.stderr.write("Invalid gateway origin\n");process.exit(1)}' $Origin
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('copilot-setup-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($temporary) | Out-Null
try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { & chmod 700 $temporary; if ($LASTEXITCODE -ne 0) { throw 'Cannot protect setup temporary directory' } }
  else {
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
    Set-Acl -LiteralPath $temporary -AclObject $acl
  }
  $runner = Join-Path $temporary 'runner.mjs'
  Invoke-WebRequest -Uri ($Origin + '/setup/runner.mjs') -OutFile $runner -MaximumRedirection 0
  if ((Get-FileHash -LiteralPath $runner -Algorithm SHA256).Hash.ToLowerInvariant() -ne '__RUNNER_SHA256__') { throw 'Setup runner checksum mismatch' }
  if ([Console]::IsInputRedirected) {
    # Forward private stdin without making bearer-bearing command arguments.
    & $bun.Source $runner setup --origin $Origin --platform windows
    $result = $LASTEXITCODE
  } else {
    $secure = Read-Host 'One-use setup token' -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
      $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
      $token | & $bun.Source $runner setup --origin $Origin --platform windows
      $result = $LASTEXITCODE
    } finally {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
      $token = $null
    }
  }
  if ($result -ne 0) { exit $result }
} finally { Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue }
