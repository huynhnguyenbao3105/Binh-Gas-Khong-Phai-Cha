param(
  [string]$CameraUrl = "rtsp://admin:L26C6CB7@192.168.1.3:554/cam/realmonitor?channel=1&subtype=1",
  [string]$PublishUrl = "rtsp://159.198.42.40:8554/cam",
  [int]$RestartDelaySeconds = 5
)

$ErrorActionPreference = "Stop"

# Kiểm tra xem FFmpeg đã được cài đặt chưa
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

Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "   WARNING SOUND - RTSP INGEST BRIDGE" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "Ingesting from: $CameraUrl"
Write-Host "Publishing to : $PublishUrl"
Write-Host "Press Ctrl+C to stop." -ForegroundColor Yellow
Write-Host "==============================================" -ForegroundColor Cyan

while ($true) {
  $startedAt = Get-Date
  Write-Host "[$($startedAt.ToString("HH:mm:ss"))] Đang kích hoạt FFmpeg Ingest..."

  $ffmpegArgs = @(
    "-hide_banner",
    "-loglevel", "warning",
    "-fflags", "nobuffer",
    "-flags", "low_delay",
    "-rtsp_transport", "tcp",
    "-i", $CameraUrl,
    "-map", "0:v:0",
    "-c:v", "copy",   # Copy original Video stream (No CPU load)
    "-an",            # Disable Audio
    "-f", "rtsp",
    "-rtsp_transport", "tcp",
    $PublishUrl
  )
  
  $process = Start-Process -FilePath $FfmpegPath -ArgumentList $ffmpegArgs -NoNewWindow -PassThru -Wait
  
  if ($process.ExitCode -ne 0) {
    Write-Host "`n[!] FFmpeg crashed or disconnected (Exit code: $($process.ExitCode)). Retrying in $RestartDelaySeconds seconds..." -ForegroundColor Red
  } else {
    Write-Host "`n[!] FFmpeg stopped gracefully. Retrying in $RestartDelaySeconds seconds..." -ForegroundColor Yellow
  }
  
  Start-Sleep -Seconds $RestartDelaySeconds
}
