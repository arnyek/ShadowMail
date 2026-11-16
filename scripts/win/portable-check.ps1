# SPDX-License-Identifier: GPL-3.0-or-later
# Portability check of a built package. Run on Windows:
#   powershell -NoProfile -ExecutionPolicy Bypass -File portable-check.ps1 -Zip <ShadowMail-x.y.z-win-x64.zip> -Work <empty folder>
# Shows windows on the desktop for a few seconds. Writes only below -Work (and reads the profile folders).
param(
  [Parameter(Mandatory)][string]$Zip,
  [Parameter(Mandatory)][string]$Work
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$exeName = 'ShadowMail.exe'

function Step($text) { Write-Output ''; Write-Output "### $text" }

function Start-App([string]$dir, [hashtable]$envVars = @{}) {
  $saved = @{}
  foreach ($k in $envVars.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k); [Environment]::SetEnvironmentVariable($k, $envVars[$k]) }
  try { return Start-Process -FilePath (Join-Path $dir $exeName) -WorkingDirectory $dir -PassThru }
  finally { foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) } }
}

function Wait-Exit($proc, [int]$seconds) {
  if (-not $proc.WaitForExit($seconds * 1000)) { return $null }
  return $proc.ExitCode
}

function App-Processes([string]$dir) {
  $exe = Join-Path $dir $exeName
  @(Get-Process -Name 'ShadowMail' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe })
}

if (Test-Path -LiteralPath $Work) { Remove-Item -LiteralPath $Work -Recurse -Force }
New-Item -ItemType Directory -Path $Work | Out-Null
$appA = Join-Path $Work 'A'
$appRO = Join-Path $Work 'RO'
Expand-Archive -LiteralPath $Zip -DestinationPath $appA
Copy-Item -LiteralPath $appA -Destination $appRO -Recurse
Write-Output "unpacked: $appA (and a copy in $appRO)"

Step 'snapshot before'
$snap = Join-Path $Work 'before.txt'
$since = (Get-Date).ToUniversalTime().ToString('o')
Start-Sleep -Seconds 2
& (Join-Path $here 'footprint.ps1') -Mode snapshot -Out $snap
Write-Output "since: $since"

Step '1. smoke run (window renders, data folder, SQLite version)'
$p = Start-App $appA @{ SHADOWMAIL_SMOKE = '1' }
$code = Wait-Exit $p 60
Write-Output "exit code: $code"
Get-Content -LiteralPath (Join-Path $appA 'data\electron\logs\smoke.json') -Encoding UTF8
$png = Get-Item -LiteralPath (Join-Path $appA 'data\electron\logs\smoke.png') -ErrorAction SilentlyContinue
Write-Output "smoke.png: $(if ($png) { "$($png.Length) bytes" } else { 'missing' })"
Write-Output 'data folder (depth 2):'
Get-ChildItem -LiteralPath (Join-Path $appA 'data') -Force | ForEach-Object { "  $($_.Name)" }
Get-ChildItem -LiteralPath (Join-Path $appA 'data\electron') -Force | ForEach-Object { "  electron\$($_.Name)" }

Step '2. second instance: no new window, the first one is focused'
$first = Start-App $appA
Start-Sleep -Seconds 6
$main = App-Processes $appA | Where-Object { $_.MainWindowHandle -ne 0 }
Write-Output "first instance windows: $(@($main).Count), title: $(@($main | ForEach-Object { $_.MainWindowTitle }) -join ', ')"
$second = Start-App $appA
$code2 = Wait-Exit $second 20
Write-Output "second instance exit code: $code2 (null = still running = FAIL)"
Start-Sleep -Seconds 1
$windows = @(App-Processes $appA | Where-Object { $_.MainWindowHandle -ne 0 })
Write-Output "windows after the second start: $($windows.Count)"
Select-String -LiteralPath (Join-Path $appA 'data\electron\logs\main.log') -Pattern 'second' | ForEach-Object { "  log: $($_.Line)" }
foreach ($w in $windows) { [void]$w.CloseMainWindow() }
$codeFirst = Wait-Exit $first 20
Write-Output "first instance closed by its window, exit code: $codeFirst"
Start-Sleep -Seconds 2
Write-Output "ShadowMail processes left: $((App-Processes $appA).Count)"

Step '3. read-only location: error dialog, nothing written'
$user = "$env:USERDOMAIN\$env:USERNAME"
icacls $appRO /deny "${user}:(W)" | Out-Null
try {
  $ro = Start-App $appRO @{ SHADOWMAIL_SMOKE = '1' }
  Write-Output "smoke-mode exit code (2 = data folder not writable): $(Wait-Exit $ro 30)"
  $ro = Start-App $appRO
  Start-Sleep -Seconds 5
  $dlg = @(App-Processes $appRO | Where-Object { $_.MainWindowHandle -ne 0 })
  Write-Output "dialog windows: $($dlg.Count), title: $(@($dlg | ForEach-Object { $_.MainWindowTitle }) -join ', ')"
  foreach ($d in $dlg) {
    $el = [System.Windows.Automation.AutomationElement]::FromHandle($d.MainWindowHandle)
    $all = $el.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($t in $all) { if ($t.Current.Name) { Write-Output "  dialog text: $($t.Current.Name -replace "`r?`n", ' | ')" } }
  }
  App-Processes $appRO | Stop-Process -Force
  Start-Sleep -Seconds 1
  Write-Output "data folder created in the read-only copy: $(Test-Path -LiteralPath (Join-Path $appRO 'data'))"
} finally {
  icacls $appRO /remove:d $user | Out-Null
}

Step 'footprint diff'
Start-Sleep -Seconds 2
& (Join-Path $here 'footprint.ps1') -Mode diff -Before $snap -Since $since

Step 'leftovers'
Write-Output "ShadowMail processes running from $Work`: $(@(Get-Process -Name 'ShadowMail' -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Work*" }).Count)"
