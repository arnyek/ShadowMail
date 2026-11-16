# SPDX-License-Identifier: GPL-3.0-or-later
# Measures whether the app writes outside its data folder.
#   footprint.ps1 -Mode snapshot -Out before.txt
#   ... run the app ...
#   footprint.ps1 -Mode diff -Before before.txt -Since <ISO time of the snapshot>
# snapshot: top-level entries of %APPDATA%, %LOCALAPPDATA%, %TEMP%.
# diff: new/removed top-level entries, plus every file or folder below the three roots that was
#       created or modified since -Since (other programs also write there; judge each line).
param(
  [Parameter(Mandatory)][ValidateSet('snapshot', 'diff')][string]$Mode,
  [string]$Out,
  [string]$Before,
  [string]$Since
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$roots = @($env:APPDATA, $env:LOCALAPPDATA, $env:TEMP)

function Get-TopLevel {
  foreach ($root in $roots) {
    Get-ChildItem -LiteralPath $root -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }
  }
}

if ($Mode -eq 'snapshot') {
  if (-not $Out) { throw '-Out is required' }
  Get-TopLevel | Sort-Object | Set-Content -LiteralPath $Out -Encoding UTF8
  Write-Output ("snapshot: {0} entries -> {1}" -f (Get-Content -LiteralPath $Out).Count, $Out)
  exit 0
}

if (-not $Before -or -not $Since) { throw '-Before and -Since are required' }
$sinceTime = [datetime]::Parse($Since).ToUniversalTime()
$old = @(Get-Content -LiteralPath $Before)
$new = @(Get-TopLevel | Sort-Object)
$added = @($new | Where-Object { $old -notcontains $_ })
$removed = @($old | Where-Object { $new -notcontains $_ })
Write-Output "== top-level entries added: $($added.Count)"
$added | ForEach-Object { Write-Output "  + $_" }
Write-Output "== top-level entries removed: $($removed.Count)"
$removed | ForEach-Object { Write-Output "  - $_" }
Write-Output "== created or modified since $($sinceTime.ToString('o')) (recursive):"
$hits = foreach ($root in $roots) {
  Get-ChildItem -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.CreationTimeUtc -ge $sinceTime -or $_.LastWriteTimeUtc -ge $sinceTime } |
    ForEach-Object { $_.FullName }
}
$hits = @($hits | Sort-Object -Unique)
Write-Output "  count: $($hits.Count)"
$hits | ForEach-Object { Write-Output "  * $_" }
$suspect = @($hits + $added | Where-Object { $_ -match '(?i)shadowmail|portable|electron|crashpad' })
Write-Output "== app-related (shadowmail|portable|electron|crashpad in the path): $($suspect.Count)"
$suspect | ForEach-Object { Write-Output "  ! $_" }
