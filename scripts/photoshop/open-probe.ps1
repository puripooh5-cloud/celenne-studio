# Opens a PSD in Photoshop with dialogs enabled and reports whether Photoshop asked anything
# (for example "Some text layers might need to be updated…"), plus the text layers it sees.
#   powershell -ExecutionPolicy Bypass -File scripts/photoshop/open-probe.ps1 -File x.psd [-Shot dir] [-Answer No]
# A dialog is recorded (title, texts, a screenshot when -Shot is given) and answered with -Answer.
param([Parameter(Mandatory = $true)][string]$File, [int]$Timeout = 25, [string]$Shot = '', [string]$Answer = 'No')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing
Add-Type 'using System; using System.Runtime.InteropServices; public static class ProbeWin { [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l); }'
$out = [System.IO.Path]::GetTempFileName()
# Photoshop opens the file itself, exactly as when a user double-clicks it.
$exe = (Get-Process Photoshop -ErrorAction SilentlyContinue | Select-Object -First 1).Path
if (-not $exe) { $exe = 'C:\Program Files\Adobe\Adobe Photoshop 2025\Photoshop.exe' }
$ps = New-Object -ComObject Photoshop.Application
Start-Process $exe -ArgumentList "`"$File`""
$dialogs = @()
$deadline = (Get-Date).AddSeconds($Timeout)
# Watch for prompts while the file opens; it is open once Photoshop lists it (COM is busy while a dialog shows).
$name = [System.IO.Path]::GetFileName($File)
$opened = $false
$A = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$P = [System.Windows.Automation.AutomationElement]::ControlTypeProperty
$CT = [System.Windows.Automation.ControlType]
while (-not $opened -and (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 700
  try { foreach ($doc in $ps.Documents) { if ($doc.Name -eq $name) { $opened = $true } } } catch { }
  $pids = @(Get-Process Photoshop -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  foreach ($w in $A::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    if ($pids -notcontains $w.Current.ProcessId) { continue }
    # Modal dialogs: windows owned by Photoshop other than the main frame, or windows nested in it.
    $cands = @($w.FindAll($TS::Children, (New-Object System.Windows.Automation.PropertyCondition($P, $CT::Window))))
    foreach ($d in $cands) {
      # (Some Photoshop alerts expose their buttons and message as panes, not buttons and texts.)
      $buttons = @($d.FindAll($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($P, $CT::Button))) | ForEach-Object { $_.Current.Name } | Where-Object { $_ })
      $panes = @($d.FindAll($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($P, $CT::Pane))) | ForEach-Object { $_.Current.Name } | Where-Object { $_ })
      if (-not $buttons) { $buttons = @($panes | Where-Object { $_ -in @('Yes', 'No', 'OK', 'Cancel', 'Update', "Don't Update") }) }
      # Only dialogs (standard dialog windows, or windows with alert buttons), never panels.
      if ($d.Current.ClassName -ne '#32770' -and -not ($buttons | Where-Object { $_ -in @('Yes', 'No', 'OK', 'Cancel', 'Update', "Don't Update") })) { continue }
      $texts = @($d.FindAll($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($P, $CT::Text))) | ForEach-Object { $_.Current.Name } | Where-Object { $_ })
      if (-not $texts) { $texts = @($panes | Where-Object { $_ -notin $buttons }) }
      $info = [ordered]@{ title = $d.Current.Name; texts = $texts; buttons = $buttons }
      if ($Shot) {
        $r = $d.Current.BoundingRectangle
        $bmp = New-Object System.Drawing.Bitmap ([int]$r.Width), ([int]$r.Height)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen([int]$r.X, [int]$r.Y, 0, 0, $bmp.Size)
        $png = Join-Path $Shot ("dialog-" + [System.IO.Path]::GetFileNameWithoutExtension($File) + "-" + $dialogs.Count + ".png")
        $bmp.Save($png); $g.Dispose(); $bmp.Dispose()
        $info.shot = $png
      }
      $dialogs += $info
      $btn = @($d.FindAll($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($P, $CT::Button)))) | Where-Object { $_.Current.Name -eq $Answer } | Select-Object -First 1
      if (-not $btn) { $btn = @($d.FindAll($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($P, $CT::Button)))) | Where-Object { $_.Current.Name -in @('No', 'Cancel', 'OK') } | Select-Object -First 1 }
      # (Photoshop's own alert boxes ignore UI Automation and WM_CLOSE; Enter answers their default button, "No".)
      if ($btn) { $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
      elseif ($Answer -eq 'Update' -and $buttons -contains 'Update') { $hw = [IntPtr]$d.Current.NativeWindowHandle; foreach ($vk in 0x09, 0x0D) { [ProbeWin]::PostMessage($hw, 0x0100, [IntPtr]$vk, [IntPtr]::Zero) | Out-Null; [ProbeWin]::PostMessage($hw, 0x0101, [IntPtr]$vk, [IntPtr]::Zero) | Out-Null; Start-Sleep -Milliseconds 300 } }
      else { $hw = [IntPtr]$d.Current.NativeWindowHandle; [ProbeWin]::PostMessage($hw, 0x0100, [IntPtr]0x0D, [IntPtr]::Zero) | Out-Null; [ProbeWin]::PostMessage($hw, 0x0101, [IntPtr]0x0D, [IntPtr]::Zero) | Out-Null }
      Start-Sleep -Milliseconds 1500
      Start-Sleep -Milliseconds 500
    }
  }
}
Start-Sleep -Milliseconds 800
& powershell -NoProfile -ExecutionPolicy Bypass -File "$PSScriptRoot\open-probe-child.ps1" -File $File -Out $out
$layers = if (Test-Path $out) { Get-Content $out -Raw -Encoding UTF8 } else { 'null' }
Remove-Item $out -ErrorAction SilentlyContinue
[ordered]@{ file = [System.IO.Path]::GetFileName($File); dialogs = $dialogs; layers = ($layers | ConvertFrom-Json) } | ConvertTo-Json -Depth 6 -Compress
