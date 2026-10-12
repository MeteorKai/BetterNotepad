param([string]$Version)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$previousLocation = Get-Location
$previousTarget = $env:CARGO_TARGET_DIR
$previousKey = $env:TAURI_SIGNING_PRIVATE_KEY
$previousPassword = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
try {
    Set-Location -LiteralPath $root
    if ($Version) { & node scripts/update-manifest.mjs --set-version $Version }
    else { & node scripts/update-manifest.mjs --check }
    if ($LASTEXITCODE -ne 0) { throw 'Release version validation failed.' }

    if (!$env:TAURI_SIGNING_PRIVATE_KEY) {
        $keyDir = Join-Path $root '.workbuddy\keys'
        $key = Join-Path $keyDir 'BetterNotepad-updater.key'
        $password = Join-Path $keyDir 'BetterNotepad-updater.password.txt'
        if (!(Test-Path -LiteralPath $key)) { throw 'Set TAURI_SIGNING_PRIVATE_KEY to the existing signing key path. Do not generate a different key for each release.' }
        $env:TAURI_SIGNING_PRIVATE_KEY = $key
        if (Test-Path -LiteralPath $password) { $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [IO.File]::ReadAllText($password).Trim() }
    }
    # Keep the running app and older release artifacts untouched.
    if (!$env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR = Join-Path $root 'src-tauri\target\update-release' }
    $target = [IO.Path]::GetFullPath($env:CARGO_TARGET_DIR)
    $env:CARGO_TARGET_DIR = $target
    & npm.cmd run tauri -- build --bundles nsis -- --locked
    if ($LASTEXITCODE -ne 0) { throw 'Signed installer build failed.' }
    $bundle = Join-Path $target 'release\bundle\nsis'
    & node scripts/update-manifest.mjs $bundle
    if ($LASTEXITCODE -ne 0) { throw 'Update manifest generation failed.' }
    Write-Host "Upload the installer, its .sig, and latest.json from: $bundle"
} finally {
    $env:CARGO_TARGET_DIR = $previousTarget
    $env:TAURI_SIGNING_PRIVATE_KEY = $previousKey
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $previousPassword
    Set-Location -LiteralPath $previousLocation.Path
}
