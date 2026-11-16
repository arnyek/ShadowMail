# SPDX-License-Identifier: GPL-3.0-or-later
# Answers a native Open / Save file dialog of one process, for the package smoke on the real exe
# (test/e2e/package-smoke.mjs: the contacts import / export and the .eml save open such dialogs in the main process).
# Win32 only (EnumWindows, typing with EM_SETSEL + WM_CHAR, BM_CLICK): the UI Automation root does not see the dialogs on a locked machine,
# EnumWindows does, and BM_CLICK on the button presses it (measured with the earlier dialog tools).
#   powershell -NoProfile -ExecutionPolicy Bypass -File answer-file-dialog.ps1 -ProcessId <pid> -Path <full path> [-TimeoutSec 30]
# Waits for a visible "#32770" top-level window of that process, writes the path into its FILE NAME box, presses its OK button
# (control id 1), and waits until it is gone. The file name box is an Edit inside a ComboBox; the address bar has one too
# (hidden, and in the Save dialog it comes first: an earlier version typed into it). So, in this order: the
# Edit whose ComboBox sits in a FloatNotifySink (the Save dialog's file name), the one whose ComboBoxEx32 has the control
# id 1148 (the Open dialog's), then any visible one outside the address bar. The text is read back before OK.
# Prints OK, or FAIL with the reason; exit code 0 / 1.
param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [Parameter(Mandatory = $true)][string]$Path,
  [int]$TimeoutSec = 30,
  # prints the dialog's child windows (class, control id, visible, the parent's class; the text of Edit and Button only)
  [switch]$Dump
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class FileDlg {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, string l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, StringBuilder l);
  public static string Text(IntPtr h) { var s = new StringBuilder(4096); SendMessage(h, 0x000D, (IntPtr)4096, s); return s.ToString(); }
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  public static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static IntPtr FindDialog(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h) && Cls(h) == "#32770") { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static List<IntPtr> Children(IntPtr parent) {
    var list = new List<IntPtr>();
    EnumChildWindows(parent, (h, l) => { list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
}
"@
$BM_CLICK = 0x00F5
$deadline = (Get-Date).AddSeconds($TimeoutSec)
$dlg = [IntPtr]::Zero
while ((Get-Date) -lt $deadline) {
  $dlg = [FileDlg]::FindDialog([uint32]$ProcessId)
  if ($dlg -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 200
}
if ($dlg -eq [IntPtr]::Zero) { Write-Output 'FAIL no dialog'; exit 1 }
# the controls appear a moment after the window
$edit = [IntPtr]::Zero
$ok = [IntPtr]::Zero
while ((Get-Date) -lt $deadline -and ($edit -eq [IntPtr]::Zero -or $ok -eq [IntPtr]::Zero)) {
  $byRank = @{}
  foreach ($c in [FileDlg]::Children($dlg)) {
    $cls = [FileDlg]::Cls($c)
    if ($ok -eq [IntPtr]::Zero -and $cls -eq 'Button' -and [FileDlg]::GetDlgCtrlID($c) -eq 1) { $ok = $c }
    if ($cls -ne 'Edit') { continue }
    $combo = [FileDlg]::GetParent($c)
    if ([FileDlg]::Cls($combo) -ne 'ComboBox') { continue }
    $outer = [FileDlg]::GetParent($combo)
    $outerCls = [FileDlg]::Cls($outer)
    $rank = 9
    if ($outerCls -eq 'FloatNotifySink') { $rank = 0 }
    elseif ($outerCls -eq 'ComboBoxEx32' -and [FileDlg]::GetDlgCtrlID($outer) -eq 1148) { $rank = 1 }
    elseif ([FileDlg]::IsWindowVisible($c) -and [FileDlg]::Cls([FileDlg]::GetParent($outer)) -notmatch 'Address|ReBar|Breadcrumb') { $rank = 2 }
    if ($rank -lt 9 -and -not $byRank.ContainsKey($rank)) { $byRank[$rank] = $c }
  }
  foreach ($r in 0, 1, 2) { if ($byRank.ContainsKey($r)) { $edit = $byRank[$r]; break } }
  if ($edit -eq [IntPtr]::Zero -or $ok -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 200 }
}
if ($Dump) {
  foreach ($c in [FileDlg]::Children($dlg)) {
    $cls = [FileDlg]::Cls($c)
    $txt = if ($cls -eq 'Edit' -or $cls -eq 'Button') { [FileDlg]::Text($c) } else { '' }
    Write-Output ('DUMP {0} id={1} vis={2} parent={3} text="{4}"{5}' -f $cls, [FileDlg]::GetDlgCtrlID($c), [FileDlg]::IsWindowVisible($c), [FileDlg]::Cls([FileDlg]::GetParent($c)), $txt, $(if ($c -eq $edit) { ' <- CHOSEN' } else { '' }))
  }
}
if ($edit -eq [IntPtr]::Zero) { Write-Output 'FAIL no file name box'; exit 1 }
if ($ok -eq [IntPtr]::Zero) { Write-Output 'FAIL no OK button'; exit 1 }
# TYPED, not set: the Save dialog keeps its preset name (Electron's defaultPath) in its own state, and a WM_SETTEXT into the
# box is not taken as an edit (measured: the box read back the path, the dialog saved the preset name). So the
# whole text is selected (EM_SETSEL 0,-1) and the path goes in character by character (WM_CHAR), as a keyboard would.
$EM_SETSEL = 0x00B1
$WM_CHAR = 0x0102
[void][FileDlg]::SendMessage($edit, $EM_SETSEL, [IntPtr]::Zero, [IntPtr](-1))
foreach ($ch in $Path.ToCharArray()) { [void][FileDlg]::SendMessage($edit, $WM_CHAR, [IntPtr][int]$ch, [IntPtr]1) }
Start-Sleep -Milliseconds 300
$typed = [FileDlg]::Text($edit)
if ($typed -ne $Path) { Write-Output "FAIL the file name box holds '$typed'"; exit 1 }
if ($Dump) { Write-Output ('DUMP after the text: chosen="{0}"' -f [FileDlg]::Text($edit)) }
[void][FileDlg]::SendMessage($ok, $BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero)
while ((Get-Date) -lt $deadline) {
  if (-not [FileDlg]::IsWindow($dlg)) { Write-Output 'OK'; exit 0 }
  Start-Sleep -Milliseconds 200
}
Write-Output 'FAIL the dialog did not close'
exit 1
