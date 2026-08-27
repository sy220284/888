$ErrorActionPreference = 'Stop'
$Root = Resolve-Path (Join-Path $PSScriptRoot '../..')
$Cache = Join-Path $Root '.devtools/cache'
$Tools = Join-Path $Root '.devtools/toolchains'
$NodeVersion = '22.19.0'
$RustVersion = '1.98.0'
$UvVersion = '0.12.0'
New-Item -ItemType Directory -Force -Path $Cache, $Tools | Out-Null

$Arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
switch ($Arch) {
  'x64' { $NodeArch = 'x64'; $RustTriple = 'x86_64-pc-windows-msvc' }
  'arm64' { $NodeArch = 'arm64'; $RustTriple = 'aarch64-pc-windows-msvc' }
  default { throw "Unsupported Windows architecture: $Arch" }
}

function Download-File([string]$Url, [string]$Target) {
  if (-not (Test-Path $Target)) {
    Write-Host "download: $Url"
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Target
  }
}

function Download-Node {
  $Archive = "node-v$NodeVersion-win-$NodeArch.zip"
  $ArchivePath = Join-Path $Cache $Archive
  $SumsPath = Join-Path $Cache "node-$NodeVersion-SHASUMS256.txt"
  Download-File "https://nodejs.org/dist/v$NodeVersion/$Archive" $ArchivePath
  Download-File "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt" $SumsPath
  $Line = Get-Content $SumsPath | Where-Object { $_ -match "\s$([regex]::Escape($Archive))$" } | Select-Object -First 1
  if (-not $Line) { throw "Node checksum entry not found: $Archive" }
  $Expected = ($Line -split '\s+')[0].ToLowerInvariant()
  $Actual = (Get-FileHash -Algorithm SHA256 $ArchivePath).Hash.ToLowerInvariant()
  if ($Expected -ne $Actual) { throw 'Node SHA-256 mismatch' }
  return $ArchivePath
}

function Install-Node {
  $ArchivePath = Download-Node
  $Prefix = Join-Path $Tools "node/$NodeVersion"
  $NodeExe = Join-Path $Prefix 'node.exe'
  if (-not (Test-Path $NodeExe)) {
    if (Test-Path $Prefix) { Remove-Item -Recurse -Force $Prefix }
    New-Item -ItemType Directory -Force -Path $Prefix | Out-Null
    $Temp = Join-Path $Cache "node-expand-$NodeVersion"
    if (Test-Path $Temp) { Remove-Item -Recurse -Force $Temp }
    Expand-Archive -Path $ArchivePath -DestinationPath $Temp -Force
    $Expanded = Get-ChildItem $Temp | Select-Object -First 1
    Copy-Item -Recurse -Force (Join-Path $Expanded.FullName '*') $Prefix
    Remove-Item -Recurse -Force $Temp
  }
  $env:PATH = "$Prefix;$env:PATH"
}

function Node-IsPinned {
  $Node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $Node) { return $false }
  return ((& node --version) -eq "v$NodeVersion")
}

function Profile-NeedsRust([string]$Profile) { return @('test','native','full') -contains $Profile }
function Profile-NeedsPython([string]$Profile) { return @('python','full') -contains $Profile }

function Download-Rustup {
  $Bin = Join-Path $Cache "rustup-init-$RustTriple.exe"
  $Sum = Join-Path $Cache "rustup-init-$RustTriple.sha256"
  Download-File "https://static.rust-lang.org/rustup/dist/$RustTriple/rustup-init.exe" $Bin
  Download-File "https://static.rust-lang.org/rustup/dist/$RustTriple/rustup-init.exe.sha256" $Sum
  $Expected = ((Get-Content $Sum -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
  $Actual = (Get-FileHash -Algorithm SHA256 $Bin).Hash.ToLowerInvariant()
  if ($Expected -ne $Actual) { throw 'rustup-init SHA-256 mismatch' }
  return $Bin
}

function Install-Rust {
  if (Get-Command rustup -ErrorAction SilentlyContinue) {
    & rustup toolchain install $RustVersion --profile minimal --component rustfmt --component clippy
  } else {
    $Rustup = Download-Rustup
    & $Rustup -y --profile minimal --default-toolchain $RustVersion --component rustfmt --component clippy
    $env:PATH = "$HOME\.cargo\bin;$env:PATH"
  }
  if ($LASTEXITCODE -ne 0) { throw 'Rust installation failed' }
  & rustup override set $RustVersion
  if ($LASTEXITCODE -ne 0) { throw 'Rust project override failed' }
}

function Install-Uv {
  $Uv = Get-Command uv -ErrorAction SilentlyContinue
  if ($Uv -and ((& uv --version) -match [regex]::Escape($UvVersion))) { return }
  $Python = Get-Command python -ErrorAction SilentlyContinue
  if (-not $Python) { throw 'Python >=3.10 is required for the python/full profile' }
  & python -m pip install --user "uv==$UvVersion"
  if ($LASTEXITCODE -ne 0) { throw 'uv installation failed' }
}

$Command = if ($args.Count -gt 0) { $args[0] } else { 'setup' }
$Profile = if ($args.Count -gt 1) { $args[1] } else { 'minimal' }

if ($Command -eq 'download') {
  Download-Node | Out-Null
  if (Profile-NeedsRust $Profile) { Download-Rustup | Out-Null }
  Write-Host "Verified bootstrap downloads are cached in $Cache"
  Write-Host 'Project dependency archives are populated later by pnpm/cargo/uv using their committed lock files.'
  exit 0
}

if (@('setup','tool') -contains $Command) {
  if (-not (Node-IsPinned)) { Install-Node }
  if (Profile-NeedsRust $Profile) { Install-Rust }
  if (Profile-NeedsPython $Profile) { Install-Uv }
  & node (Join-Path $Root 'scripts/devtools/dev.mjs') @args
  exit $LASTEXITCODE
}

throw 'usage: bootstrap.ps1 <setup|download> <profile>'
