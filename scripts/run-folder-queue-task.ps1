param(
  [Alias('QueueRoot')]
  [string]$RootDir = '',
  [switch]$TestMode = $true,
  [switch]$Rollback = $true,
  [int]$RollbackDelaySeconds = 120,
  [string]$BackgroundMode = 'keep'
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$nodePath = (Get-Command node).Source
$scriptPath = Join-Path $repoRoot 'scripts\process-folder-queue.mjs'
$resolvedRootDir = if ($RootDir) {
  $RootDir
} elseif ($env:FOLDER_QUEUE_ROOT) {
  $env:FOLDER_QUEUE_ROOT
} else {
  throw 'RootDir is required.'
}

Set-Location $repoRoot

$arguments = @(
  $scriptPath,
  '--root',
  $resolvedRootDir,
  '--background',
  $BackgroundMode
)

if ($TestMode) {
  $arguments += '--mode'
  $arguments += 'test'
} else {
  $arguments += '--mode'
  $arguments += 'live'
}

if ($Rollback) {
  $arguments += '--rollback-delay-sec'
  $arguments += $RollbackDelaySeconds
} else {
  $arguments += '--rollback-delay-sec'
  $arguments += 0
}

& $nodePath @arguments
