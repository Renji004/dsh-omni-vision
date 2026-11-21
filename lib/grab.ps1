# dsh-omni-vision: local screen capture (Windows, System.Drawing, PowerShell 5.1)
# Usage:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File grab.ps1 -Out <png> [-Scope window|screen|region|list]
#                    [-Title <substring>] [-X <int> -Y <int> -W <int> -H <int>]
# Output: single JSON document on stdout (UTF-8). Fully local, no network, no upload.
#
# Scopes:
#   window (default) - the foreground window, or the first window whose title
#                      contains -Title (case-insensitive)
#   screen           - the whole virtual screen (all monitors)
#   region           - the explicit -X -Y -W -H rectangle
#   list             - no capture; reports every visible top-level window
#
# The capture is a plain CopyFromScreen of the target rectangle: it records what
# is actually on screen, so a window covered by another window is captured covered.

param(
  [string]$Out = '',
  [string]$Scope = 'window',
  [string]$Title = '',
  [int]$X = 0,
  [int]$Y = 0,
  [int]$W = 0,
  [int]$H = 0
)

# Ensure UTF-8 stdout so non-ASCII window titles survive the pipe to Node.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$result = [ordered]@{
  ok      = $false
  tool    = 'windows-grab'
  error   = ''
  scope   = $Scope
  path    = $Out
  width   = 0
  height  = 0
  title   = ''
  process = ''
  pid     = 0
  bounds  = [ordered]@{ x = 0; y = 0; w = 0; h = 0 }
  windows = @()
}

try {
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Windows.Forms

  if (-not ('DshGrab.Native' -as [type])) {
    Add-Type -Namespace DshGrab -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@
  }

  # Measure in physical pixels so GetWindowRect and CopyFromScreen agree on
  # scaled displays (125% / 150%): without this the capture is cropped or blurry.
  try { $null = [DshGrab.Native]::SetProcessDPIAware() } catch {}

  function Get-WinRect([IntPtr]$Handle) {
    $rect = New-Object DshGrab.Native+RECT
    if (-not [DshGrab.Native]::GetWindowRect($Handle, [ref]$rect)) { return $null }
    $w = $rect.Right - $rect.Left
    $h = $rect.Bottom - $rect.Top
    if ($w -le 0 -or $h -le 0) { return $null }
    return [ordered]@{ x = $rect.Left; y = $rect.Top; w = $w; h = $h }
  }

  function Get-VisibleWindows {
    $list = @()
    foreach ($proc in (Get-Process -ErrorAction SilentlyContinue)) {
      try {
        if ($proc.MainWindowHandle -eq $null -or $proc.MainWindowHandle -eq [IntPtr]::Zero) { continue }
        if ([DshGrab.Native]::IsIconic($proc.MainWindowHandle)) { continue }
        $rect = Get-WinRect $proc.MainWindowHandle
        if ($rect -eq $null) { continue }
        $list += [ordered]@{
          title   = [string]$proc.MainWindowTitle
          process = [string]$proc.ProcessName
          pid     = [int]$proc.Id
          x       = [int]$rect.x
          y       = [int]$rect.y
          w       = [int]$rect.w
          h       = [int]$rect.h
        }
      } catch {
        continue
      }
    }
    return @($list | Where-Object { $_.title -ne '' -and $_.w -ge 80 -and $_.h -ge 60 } |
      Sort-Object -Property @{ Expression = { $_.w * $_.h }; Descending = $true })
  }

  $windows = Get-VisibleWindows
  $result.windows = @($windows | Select-Object -First 40)

  $target = $null
  $effectiveScope = $Scope.ToLowerInvariant()

  if ($effectiveScope -eq 'list') {
    $result.ok = $true
    if ($windows.Count -eq 0) { $result.error = 'no visible top-level windows' }
  } elseif ($effectiveScope -eq 'screen') {
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $target = [ordered]@{ x = $vs.X; y = $vs.Y; w = $vs.Width; h = $vs.Height; title = '(virtual screen)'; process = ''; pid = 0 }
  } elseif ($effectiveScope -eq 'region') {
    if ($W -le 0 -or $H -le 0) { throw "region scope needs positive -W and -H (got ${W}x${H})" }
    $target = [ordered]@{ x = $X; y = $Y; w = $W; h = $H; title = '(region)'; process = ''; pid = 0 }
  } elseif ($effectiveScope -eq 'window') {
    if ($Title -ne '') {
      $match = $windows | Where-Object { $_.title.IndexOf($Title, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object -First 1
      if ($match -eq $null) { throw "no visible window title contains ""$Title""" }
      $target = [ordered]@{ x = $match.x; y = $match.y; w = $match.w; h = $match.h; title = $match.title; process = $match.process; pid = $match.pid }
    } else {
      $hwnd = [DshGrab.Native]::GetForegroundWindow()
      if ($hwnd -eq [IntPtr]::Zero) { throw 'no foreground window' }
      if ([DshGrab.Native]::IsIconic($hwnd)) { throw 'the foreground window is minimized' }
      $rect = Get-WinRect $hwnd
      if ($rect -eq $null) { throw 'the foreground window has no screen rectangle (invisible or minimized)' }
      $target = [ordered]@{ x = $rect.x; y = $rect.y; w = $rect.w; h = $rect.h; title = '(foreground window)'; process = ''; pid = 0 }
    }
  } else {
    throw "unknown scope ""$Scope"" (expected window | screen | region | list)"
  }

  if ($target -ne $null) {
    if ($Out -eq '') { throw '-Out is required when capturing' }
    # Guard against absurd captures (a broken window rect can span the desktop).
    $maxSide = 12000
    if ($target.w -gt $maxSide -or $target.h -gt $maxSide) {
      throw "capture rectangle ${($target.w)}x${($target.h)} exceeds the ${maxSide}px safety limit"
    }
    $target.w = [int]$target.w
    $target.h = [int]$target.h

    New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName($Out)) | Out-Null

    $bitmap = New-Object System.Drawing.Bitmap($target.w, $target.h)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $null = $graphics.CopyFromScreen($target.x, $target.y, 0, 0, (New-Object System.Drawing.Size($target.w, $target.h)))
      $bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      $graphics.Dispose()
      $bitmap.Dispose()
    }

    $result.ok = $true
    $result.width = [int]$target.w
    $result.height = [int]$target.h
    $result.title = [string]$target.title
    $result.process = [string]$target.process
    $result.pid = [int]$target.pid
    $result.bounds = [ordered]@{ x = [int]$target.x; y = [int]$target.y; w = [int]$target.w; h = [int]$target.h }
  }
} catch {
  $result.ok = $false
  $result.error = $_.Exception.Message
}

$result | ConvertTo-Json -Depth 6 -Compress
