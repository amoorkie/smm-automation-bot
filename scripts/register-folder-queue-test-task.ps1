param(
  [Alias('QueueRoot')]
  [string]$RootDir = '',
  [int]$DelayMinutes = 5,
  [int]$RollbackDelaySeconds = 120,
  [string]$BackgroundMode = 'keep'
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$runnerPath = Join-Path $repoRoot 'scripts\run-folder-queue-task.ps1'
$taskName = 'SMM-Automation-Bot-FolderQueue-Test'
$resolvedRootDir = if ($RootDir) {
  $RootDir
} elseif ($env:FOLDER_QUEUE_ROOT) {
  $env:FOLDER_QUEUE_ROOT
} else {
  throw 'RootDir is required.'
}
$runAt = (Get-Date).AddMinutes($DelayMinutes)
$taskCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$runnerPath`" -RootDir `"$resolvedRootDir`" -TestMode -Rollback -RollbackDelaySeconds $RollbackDelaySeconds -BackgroundMode $BackgroundMode"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runnerPath`" -RootDir `"$resolvedRootDir`" -TestMode -Rollback -RollbackDelaySeconds $RollbackDelaySeconds -BackgroundMode $BackgroundMode"
$trigger = New-ScheduledTaskTrigger -Once -At $runAt

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Force | Out-Null

Write-Output "Task '$taskName' registered for $($runAt.ToString('yyyy-MM-dd HH:mm'))."
Write-Output "Queue root: $resolvedRootDir"
Write-Output "Command: $taskCommand"
