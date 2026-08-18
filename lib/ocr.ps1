# dsh-omni-vision: local OCR via Windows.Media.Ocr (WinRT, PowerShell 5.1)
# Usage:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File ocr.ps1 -Path <png>
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File ocr.ps1 -ListEngines
# Output: single JSON document on stdout (UTF-8). Fully local, no network.

param(
  [string]$Path = '',
  [switch]$ListEngines
)

# WinRT StorageFile requires backslash paths; normalize forward slashes.
if ($Path) { $Path = $Path.Replace('/', '\') }

# Ensure UTF-8 stdout so CJK text survives the pipe to Node.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$result = [ordered]@{
  ok      = $false
  tool    = 'windows-ocr'
  error   = ''
  engines = @()
  language = ''
  lines   = @()
  path    = $Path
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

  # Generic await for IAsyncOperation<T>; unwraps AggregateException so the real
  # failure surfaces (GetAwaiter().GetResult() throws the inner exception directly).
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
  if (-not $asTaskGeneric) { throw 'AsTask helper not found (missing WinRT runtime extensions).' }
  function Await($WinRtTask, $ResultType, $Label) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    try {
      return $netTask.GetAwaiter().GetResult()
    } catch {
      $e = $_.Exception
      $depth = 0
      while ($e.InnerException -and $depth -lt 8) { $e = $e.InnerException; $depth++ }
      $detail = if ($null -ne $e) { $e.Message } else { $_.Exception.Message }
      throw "${Label} failed: $detail"
    }
  }

  $available = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages
  $engines = @()
  if ($available) {
    foreach ($l in $available) {
      $engines += [ordered]@{ tag = $l.LanguageTag; name = $l.DisplayName }
    }
  }
  $result.engines = $engines

  if ($ListEngines) {
    $result.ok = $true
    $result.maxDimension = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
    $result | ConvertTo-Json -Depth 6 -Compress
    exit 0
  }

  if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Image not found: $Path"
  }

  $engine = $null
  try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() } catch {}
  if (-not $engine) {
    # Fallback: try en-US, then the first available language.
    foreach ($candidate in @('en-US') + @($available | ForEach-Object { $_.LanguageTag })) {
      try {
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($candidate))
        if ($engine) { break }
      } catch {}
    }
  }
  if (-not $engine) {
    throw 'No Windows OCR engine available (install an OCR language pack).'
  }
  $result.language = $engine.RecognizerLanguage.LanguageTag

  $file    = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile]) 'GetFileFromPath'
  $stream  = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream]) 'OpenStream'
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder]) 'CreateDecoder'
  $bitmap  = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap]) 'DecodeBitmap'

  $ocr = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult]) 'Recognize'
  $lineObjs = @()
  if ($ocr -and $ocr.Lines) {
    foreach ($line in $ocr.Lines) {
      # Note: OcrWord-level properties (Text/Confidence) project as $null under
      # Windows PowerShell 5.1, so only the per-line text is reported.
      $lineObjs += [ordered]@{ text = [string]$line.Text }
    }
  }
  $result.lines = $lineObjs
  $result.ok = $true
} catch {
  $result.error = $_.Exception.Message
}

$result | ConvertTo-Json -Depth 6 -Compress
