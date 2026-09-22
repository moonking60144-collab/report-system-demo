param(
  [Parameter(Mandatory = $true)]
  [string]$RepoDir,

  [Parameter(Mandatory = $true)]
  [string]$BackendDir,

  [Parameter(Mandatory = $true)]
  [string]$FrontendDir,

  [Parameter(Mandatory = $true)]
  [string]$BeforeCommit,

  [Parameter(Mandatory = $true)]
  [string]$OutputCmd,

  [string]$FrontendDeployDir = ""
)

$ErrorActionPreference = "Stop"

function ConvertTo-Flag([bool]$Value) {
  if ($Value) { return "1" }
  return "0"
}

function Test-AnyChangedPath([string[]]$ChangedPaths, [string[]]$Regexes) {
  foreach ($path in $ChangedPaths) {
    foreach ($regex in $Regexes) {
      if ($path -match $regex) {
        return $true
      }
    }
  }
  return $false
}

function Add-ChangedPaths([hashtable]$Target, [string[]]$Paths) {
  foreach ($path in $Paths) {
    $normalized = [string]$path
    if ($normalized.Trim().Length -gt 0) {
      $Target[$normalized.Trim()] = $true
    }
  }
}

function Get-NormalizedRootPath([string]$Root) {
  $rootPath = (Get-Item -LiteralPath $Root).FullName
  while ($rootPath.EndsWith("\") -or $rootPath.EndsWith("/")) {
    $rootPath = $rootPath.Substring(0, $rootPath.Length - 1)
  }
  return $rootPath
}

function Get-DirectoryFileSnapshot([string]$Root) {
  $snapshot = @{}
  if (-not (Test-Path -LiteralPath $Root)) {
    return $snapshot
  }

  $rootPath = Get-NormalizedRootPath $Root
  Get-ChildItem -LiteralPath $Root -File -Recurse | ForEach-Object {
    $relativePath = $_.FullName.Substring($rootPath.Length).TrimStart([char[]]@('\', '/'))
    $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    $snapshot[$relativePath] = "$($_.Length):$hash"
  }
  return $snapshot
}

function Test-DirectorySnapshotsDiffer([string]$SourceRoot, [string]$TargetRoot) {
  if (-not (Test-Path -LiteralPath $SourceRoot)) {
    return $false
  }
  if (-not (Test-Path -LiteralPath $TargetRoot)) {
    return $true
  }

  $sourceSnapshot = Get-DirectoryFileSnapshot $SourceRoot
  $targetSnapshot = Get-DirectoryFileSnapshot $TargetRoot
  if ($sourceSnapshot.Count -ne $targetSnapshot.Count) {
    return $true
  }

  foreach ($path in $sourceSnapshot.Keys) {
    if (-not $targetSnapshot.ContainsKey($path)) {
      return $true
    }
    if ($sourceSnapshot[$path] -ne $targetSnapshot[$path]) {
      return $true
    }
  }

  foreach ($path in $targetSnapshot.Keys) {
    if (-not $sourceSnapshot.ContainsKey($path)) {
      return $true
    }
  }

  return $false
}

function Get-FrontendEnvFingerprint([string]$FrontendRoot) {
  $envFileNames = @(
    ".env",
    ".env.local",
    ".env.production",
    ".env.production.local"
  )
  $parts = @()
  foreach ($name in $envFileNames) {
    $path = Join-Path $FrontendRoot $name
    if (Test-Path -LiteralPath $path) {
      $item = Get-Item -LiteralPath $path
      $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
      $parts += "${name}:$($item.Length):$hash"
    }
  }
  if ($parts.Count -eq 0) {
    return "__none__"
  }
  return ($parts -join "|")
}

$repoFullPath = (Resolve-Path -LiteralPath $RepoDir).Path
$backendFullPath = (Resolve-Path -LiteralPath $BackendDir).Path
$frontendFullPath = (Resolve-Path -LiteralPath $FrontendDir).Path
$frontendDeployFullPath = $null
if ($FrontendDeployDir -and $FrontendDeployDir.Trim().Length -gt 0) {
  $frontendDeployFullPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($FrontendDeployDir)
}
$afterCommit = (& git -C $repoFullPath rev-parse HEAD).Trim()

$changedPathMap = @{}
if ($BeforeCommit -and $BeforeCommit -ne $afterCommit) {
  Add-ChangedPaths $changedPathMap @(& git -C $repoFullPath diff --name-only "$BeforeCommit..$afterCommit")
}
if ($changedPathMap.Count -eq 0) {
  $upstreamOutput = & git -C $repoFullPath rev-parse --abbrev-ref --symbolic-full-name "@{u}" 2>$null
  if ($LASTEXITCODE -eq 0 -and $upstreamOutput) {
    $upstreamRef = ($upstreamOutput | Select-Object -First 1).Trim()
    $aheadCount = [int]((& git -C $repoFullPath rev-list --count "$upstreamRef..HEAD").Trim())
    if ($aheadCount -gt 0) {
      Add-ChangedPaths $changedPathMap @(& git -C $repoFullPath diff --name-only "$upstreamRef..HEAD")
    }
  }
}

# Server 上偶爾會有手動貼腳本、hotfix 或未追蹤檔案；這些不在 commit diff 裡，
# 但仍會影響本次啟動是否需要 rebuild。併入 staged / unstaged / untracked，避免錯誤 skip。
Add-ChangedPaths $changedPathMap @(& git -C $repoFullPath diff --name-only)
Add-ChangedPaths $changedPathMap @(& git -C $repoFullPath diff --cached --name-only)
Add-ChangedPaths $changedPathMap @(& git -C $repoFullPath ls-files --others --exclude-standard)

$changedPaths = @()
foreach ($path in $changedPathMap.Keys) {
  $changedPaths += $path
}

$backendInstall = Test-AnyChangedPath $changedPaths @(
  "^backend/package\.json$",
  "^backend/package-lock\.json$"
)
$frontendInstall = Test-AnyChangedPath $changedPaths @(
  "^frontend/package\.json$",
  "^frontend/package-lock\.json$"
)

$backendBuild = $backendInstall -or (Test-AnyChangedPath $changedPaths @(
  "^backend/src/",
  "^backend/scripts/",
  "^backend/tsconfig(\.[^/]+)?\.json$",
  "^shared/"
))
$frontendBuild = $frontendInstall -or (Test-AnyChangedPath $changedPaths @(
  "^frontend/src/",
  "^frontend/public/",
  "^frontend/index\.html$",
  "^frontend/vite\.config\.",
  "^frontend/tsconfig(\.[^/]+)?\.json$",
  "^shared/"
))

if (-not (Test-Path -LiteralPath (Join-Path $backendFullPath "node_modules"))) {
  $backendInstall = $true
  $backendBuild = $true
}
if (-not (Test-Path -LiteralPath (Join-Path $frontendFullPath "node_modules"))) {
  $frontendInstall = $true
  $frontendBuild = $true
}
if (-not (Test-Path -LiteralPath (Join-Path $backendFullPath "dist\server.js"))) {
  $backendBuild = $true
}
$frontendDistPath = Join-Path $frontendFullPath "dist"
$frontendDistIndexPath = Join-Path $frontendDistPath "index.html"
if (-not (Test-Path -LiteralPath $frontendDistIndexPath)) {
  $frontendBuild = $true
}

$frontendEnvFingerprint = Get-FrontendEnvFingerprint $frontendFullPath
$frontendEnvFingerprintChanged = $false
if ($frontendDeployFullPath) {
  $frontendEnvFingerprintFile = Join-Path $frontendDeployFullPath ".ragic-report-frontend-env.sha256"
  $previousFrontendEnvFingerprint = ""
  if (Test-Path -LiteralPath $frontendEnvFingerprintFile) {
    $previousFrontendEnvFingerprint = (Get-Content -LiteralPath $frontendEnvFingerprintFile -Raw).Trim()
  }
  if ($previousFrontendEnvFingerprint -ne $frontendEnvFingerprint) {
    $frontendEnvFingerprintChanged = $true
    $frontendBuild = $true
  }
}

$frontendDeployNeedsSync = $false
if ($frontendDeployFullPath) {
  $frontendDeployNeedsSync = Test-DirectorySnapshotsDiffer $frontendDistPath $frontendDeployFullPath
}

$frontendSync = $frontendBuild -or $frontendDeployNeedsSync

$outputLines = @(
  "@echo off",
  "set `"RUN_BACKEND_INSTALL=$(ConvertTo-Flag $backendInstall)`"",
  "set `"RUN_BACKEND_BUILD=$(ConvertTo-Flag $backendBuild)`"",
  "set `"RUN_FRONTEND_INSTALL=$(ConvertTo-Flag $frontendInstall)`"",
  "set `"RUN_FRONTEND_BUILD=$(ConvertTo-Flag $frontendBuild)`"",
  "set `"RUN_FRONTEND_SYNC=$(ConvertTo-Flag $frontendSync)`"",
  "set `"FRONTEND_ENV_FINGERPRINT=$frontendEnvFingerprint`""
)
Set-Content -LiteralPath $OutputCmd -Value $outputLines -Encoding ASCII

if ($changedPaths.Count -eq 0) {
  Write-Host "[scope] no git changes since previous HEAD"
} else {
  Write-Host ("[scope] changed files: " + $changedPaths.Count)
}
Write-Host ("[scope] backend install/build: " + (ConvertTo-Flag $backendInstall) + "/" + (ConvertTo-Flag $backendBuild))
Write-Host ("[scope] frontend install/build/sync: " + (ConvertTo-Flag $frontendInstall) + "/" + (ConvertTo-Flag $frontendBuild) + "/" + (ConvertTo-Flag $frontendSync))
Write-Host ("[scope] frontend env fingerprint changed: " + (ConvertTo-Flag $frontendEnvFingerprintChanged))
if ($frontendDeployFullPath) {
  Write-Host ("[scope] frontend deploy target needs sync: " + (ConvertTo-Flag $frontendDeployNeedsSync))
}
