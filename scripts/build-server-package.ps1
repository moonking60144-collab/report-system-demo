param(
  [string]$OutputDir = ".deploy",
  [string]$PackageName = "",
  [switch]$SkipBuild,
  [switch]$CreateZip
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$npmCommand = if (Get-Command "npm.cmd" -ErrorAction SilentlyContinue) {
  "npm.cmd"
}
elseif (Get-Command "npm" -ErrorAction SilentlyContinue) {
  "npm"
}
else {
  throw "npm executable not found in PATH."
}

function Copy-FilteredTree {
  param(
    [string]$Source,
    [string]$Destination,
    [string[]]$DirectoryExcludes = @(),
    [string[]]$FileExcludes = @()
  )

  $sourceRoot = [System.IO.Path]::GetFullPath($Source)
  if (-not (Test-Path $sourceRoot)) {
    throw "Source path not found: $Source"
  }

  New-Item -ItemType Directory -Force -Path $Destination | Out-Null

  Get-ChildItem -LiteralPath $sourceRoot -Force -Recurse | ForEach-Object {
    $fullName = [System.IO.Path]::GetFullPath($_.FullName)
    $relativePath = $fullName.Substring($sourceRoot.Length).TrimStart('\')
    if (-not $relativePath) {
      return
    }

    $segments = $relativePath -split '[\\/]'
    foreach ($excludedDirectory in $DirectoryExcludes) {
      if ($segments -contains $excludedDirectory) {
        return
      }
    }

    if (-not $_.PSIsContainer -and ($FileExcludes -contains $_.Name)) {
      return
    }

    $targetPath = Join-Path $Destination $relativePath
    if ($_.PSIsContainer) {
      New-Item -ItemType Directory -Force -Path $targetPath | Out-Null
      return
    }

    $targetDirectory = Split-Path -Parent $targetPath
    if ($targetDirectory) {
      New-Item -ItemType Directory -Force -Path $targetDirectory | Out-Null
    }
    Copy-Item -LiteralPath $fullName -Destination $targetPath -Force
  }
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$backendDir = Join-Path $repoRoot "backend"
$frontendDir = Join-Path $repoRoot "frontend"
$frontendDistDir = Join-Path $frontendDir "dist"
if (-not $PackageName) {
  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $PackageName = "$timestamp-ragic-report-updated-version-sever"
}

$outputRoot = Join-Path $repoRoot $OutputDir
$stagingDir = Join-Path $outputRoot $PackageName
$zipPath = Join-Path $outputRoot "$PackageName.zip"

if (-not $SkipBuild) {
  Write-Host "[INFO] Building backend..."
  Push-Location $backendDir
  try {
    & $npmCommand run build
  }
  finally {
    Pop-Location
  }

  Write-Host "[INFO] Building frontend..."
  Push-Location $frontendDir
  try {
    & $npmCommand run build
  }
  finally {
    Pop-Location
  }
}

if (-not (Test-Path $frontendDistDir)) {
  throw "frontend/dist not found. Run frontend build first, or omit -SkipBuild."
}

if (Test-Path $stagingDir) {
  Remove-Item -Recurse -Force $stagingDir
}

if ($CreateZip -and (Test-Path $zipPath)) {
  Remove-Item -Force $zipPath
}

New-Item -ItemType Directory -Force -Path $stagingDir | Out-Null

$backendTarget = Join-Path $stagingDir "backend"
$frontendTarget = Join-Path $stagingDir "frontend-dist"

Write-Host "[INFO] Copying backend package..."
Copy-FilteredTree `
  -Source $backendDir `
  -Destination $backendTarget `
  -DirectoryExcludes @("node_modules", ".cache", ".data", ".tmp-test-dist", "tests") `
  -FileExcludes @(".env", "tsconfig.test.json")

Write-Host "[INFO] Copying frontend dist..."
Copy-FilteredTree `
  -Source $frontendDistDir `
  -Destination $frontendTarget

if ($CreateZip) {
  Write-Host "[INFO] Creating zip package..."
  Compress-Archive -Path $stagingDir -DestinationPath $zipPath -Force
  Write-Host "[DONE] Package created:"
  Write-Host "  Folder: $stagingDir"
  Write-Host "  Zip:    $zipPath"
  exit 0
}

Write-Host "[DONE] Package folder created:"
Write-Host "  $stagingDir"
