$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $Root 'scripts/devtools/bootstrap.ps1') @args
exit $LASTEXITCODE
