$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (Get-Command node -ErrorAction SilentlyContinue) {
  & node (Join-Path $Root 'scripts/devtools/dev.mjs') @args
  exit $LASTEXITCODE
}
if ($args.Count -gt 0 -and @('setup','download','tool') -contains $args[0]) {
  & (Join-Path $Root 'scripts/devtools/bootstrap.ps1') @args
  exit $LASTEXITCODE
}
Write-Error 'Node is not available. Run: .\dev.ps1 setup minimal'
