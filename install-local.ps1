$ErrorActionPreference = "Stop"

$ProjectDir = $PSScriptRoot
if (-not $ProjectDir) {
    $ProjectDir = (Get-Location).Path
}

$ReleaseDir = $env:PI_LOCAL_RELEASE_DIR
if (-not $ReleaseDir) {
    $ReleaseDir = Join-Path $env:TEMP "pi-personal-release"
}

Set-Location $ProjectDir

Write-Host "Building local release artifacts..."
npm run release:local -- --out "$ReleaseDir" --force --skip-check --skip-test --skip-install

$TarballsDir = Join-Path $ReleaseDir "tarballs"
$Tarballs = Get-ChildItem -Path $TarballsDir -Filter "*.tgz" -File -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName

if (-not $Tarballs -or $Tarballs.Count -eq 0) {
    Write-Error "No npm tarballs were created in $TarballsDir"
    exit 1
}

Write-Host "Installing the local packages globally..."
npm install -g --ignore-scripts @Tarballs

$PiCommand = Get-Command pi -ErrorAction SilentlyContinue

if (-not $PiCommand) {
    $NpmPrefix = (npm prefix -g).Trim()
    Write-Warning "Installation completed, but 'pi' is not available in PATH."
    Write-Warning "Global npm bin directory is typically: $NpmPrefix"
    exit 1
}

Write-Host "Installed local Pi variant:"
Write-Host "  Executable: $($PiCommand.Source)"
Write-Host "  Version: $(pi --version)"
