param(
  [string]$PublishHost = "localhost",
  # [string]$PublishHost = "159.198.42.40",
  [int]$RtspPort = 8554,
  [int]$RestartDelaySeconds = 5
)

$ErrorActionPreference = "Stop"

# Them camera: copy 1 dong trong mang, doi Name / Path / RtspUrl.
# CodecArgs:
# - H.264: @("copy") — nhe CPU
# - H.265 / cam loi copy: @("libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-b:v", "1M")
$Cameras = @(
  @{
    Name      = "Camera 1"
    Path      = "cam"
    RtspUrl   = "rtsp://admin:L26C6CB7@192.168.1.3:554/cam/realmonitor?channel=1&subtype=1"
    CodecArgs = @("copy")
  }
  @{
    Name      = "Camera 2"
    Path      = "cam2"
    RtspUrl   = "rtsp://192.168.1.140/live/0/SUB"
    CodecArgs = @("libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-b:v", "1M")
  }
)

$FfmpegPath = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source
if (-not $FfmpegPath) {
  Write-Host "FFmpeg not found. Trying to find in WinGet packages..."
  $wingetFfmpeg = Get-ChildItem -Path "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter ffmpeg.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
  if ($wingetFfmpeg) {
    $FfmpegPath = $wingetFfmpeg
  }
}

if (-not $FfmpegPath -or -not (Test-Path $FfmpegPath)) {
  Write-Host "CRITICAL ERROR: FFmpeg is not installed on this machine!" -ForegroundColor Red
  Write-Host "Please install FFmpeg before running this script."
  exit 1
}

function Mask-Rtsp([string]$url) {
  if (-not $url) { return "" }
  return ($url -replace "://([^:/]+):([^@/]+)@", "://`$1:***@")
}

$jobs = @()
foreach ($cam in $Cameras) {
  if (-not $cam.RtspUrl -or -not $cam.Path) { continue }
  $jobs += [pscustomobject]@{
    Name       = $(if ($cam.Name) { $cam.Name } else { $cam.Path })
    Path       = [string]$cam.Path
    RtspUrl    = [string]$cam.RtspUrl
    CodecArgs  = if ($cam.CodecArgs) { $cam.CodecArgs } else { @("copy") }
    PublishUrl = "rtsp://${PublishHost}:${RtspPort}/$($cam.Path)"
  }
}

if ($jobs.Count -eq 0) {
  Write-Host "Chua khai bao camera nao trong `$Cameras." -ForegroundColor Red
  exit 1
}

Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "   WARNING SOUND - RTSP INGEST BRIDGE" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
foreach ($cam in $jobs) {
  Write-Host ("  {0}: {1}  ->  {2}" -f $cam.Name, (Mask-Rtsp $cam.RtspUrl), $cam.PublishUrl)
}
Write-Host "Press Ctrl+C to stop all." -ForegroundColor Yellow
Write-Host "==============================================" -ForegroundColor Cyan

$states = @{}
foreach ($cam in $jobs) {
  $states[$cam.Path] = @{
    Cam       = $cam
    Process   = $null
    NextStart = Get-Date
  }
}

function Start-CamIngest($state) {
  $cam = $state.Cam
  $ffmpegArgs = @(
    "-hide_banner",
    "-loglevel", "warning",
    "-fflags", "nobuffer",
    "-flags", "low_delay",
    "-rtsp_transport", "tcp",
    "-i", $cam.RtspUrl,
    "-map", "0:v:0",
    "-c:v"
  )
  $ffmpegArgs += $cam.CodecArgs
  $ffmpegArgs += @(
    "-an",
    "-f", "rtsp",
    "-rtsp_transport", "tcp",
    $cam.PublishUrl
  )

  Write-Host ("[{0}] {1}: bat FFmpeg -> {2} (Codec: {3})" -f (Get-Date -Format "HH:mm:ss"), $cam.Name, $cam.PublishUrl, ($cam.CodecArgs -join " ")) -ForegroundColor Green
  $state.Process = Start-Process -FilePath $FfmpegPath -ArgumentList $ffmpegArgs -NoNewWindow -PassThru
}

function Stop-AllIngest {
  foreach ($state in @($states.Values)) {
    if ($state.Process -and -not $state.Process.HasExited) {
      try { Stop-Process -Id $state.Process.Id -Force -ErrorAction SilentlyContinue } catch {}
    }
  }
}

Register-EngineEvent PowerShell.Exiting -Action { Stop-AllIngest } | Out-Null
try {
  while ($true) {
    foreach ($id in @($states.Keys)) {
      $state = $states[$id]
      $proc = $state.Process
      if ($proc -and -not $proc.HasExited) { continue }
      if ($proc -and $proc.HasExited) {
        Write-Host ("[{0}] {1}: FFmpeg dung (exit {2}). Thu lai sau {3}s..." -f (Get-Date -Format "HH:mm:ss"), $state.Cam.Name, $proc.ExitCode, $RestartDelaySeconds) -ForegroundColor Red
        $state.Process = $null
        $state.NextStart = (Get-Date).AddSeconds($RestartDelaySeconds)
      }
      if ((Get-Date) -ge $state.NextStart) {
        Start-CamIngest $state
      }
    }
    Start-Sleep -Milliseconds 800
  }
} finally {
  Write-Host "Dang dung tat ca FFmpeg..." -ForegroundColor Yellow
  Stop-AllIngest
}
