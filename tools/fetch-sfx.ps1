# Fetch the interaction sound effects from mixkit.co and process them with ffmpeg.
#
#   pwsh tools/fetch-sfx.ps1
#
# Source: https://mixkit.co/free-sound-effects/  (Mixkit Free License)
# Each entry is a mixkit asset id; the preview mp3 is the downloadable asset.
#
# Processing per clip:
#   1. strip leading silence
#   2. trim to a length that suits a desktop pet (short feedback, not a jingle)
#   3. fade the tail so it never clicks
#   4. peak-normalise to -3 dBFS (headroom matters: sounds often overlap)
#   5. mono / 22.05 kHz / 96 kbps mp3  -> a few KB each
#
# Requires ffmpeg + ffprobe on PATH. Chinese is avoided in this file on purpose:
# earlier a stray encoding issue inside a here-string ate a line of code.

# ffmpeg/ffprobe write their progress to stderr, and with ErrorActionPreference
# set to Stop that becomes a terminating NativeCommandError. Keep it Continue and
# check results explicitly instead.
$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$outDir = Join-Path $root 'app\sfx'
$tmpDir = Join-Path $env:TEMP 'sfxsrc'
New-Item -ItemType Directory -Force -Path $outDir, $tmpDir | Out-Null

# name -> @(mixkitId, maxSeconds)
$picks = [ordered]@{
  squeak  = @(1014, 0.90)   # Rubber duck squeak
  happy   = @(2885, 1.40)   # Funny Giggling
  nom     = @(2244, 1.00)   # Chewing something crunchy
  boing   = @(2894, 0.95)   # Boing hit sound
  splash  = @(1311, 1.15)   # Water splash
  sparkle = @(3062, 1.60)   # Magic wand sparkle
  levelup = @(600,  1.80)   # Achievement bell
  sleepy  = @(2268, 1.45)   # Cartoon vocal yawn
  no      = @(473,  1.00)   # Cartoon failure piano
  wake    = @(616,  0.95)   # Cartoon toy whistle
}

$proxy = 'http://127.0.0.1:7897'
$useProxy = (Test-NetConnection 127.0.0.1 -Port 7897 -WarningAction SilentlyContinue).TcpTestSucceeded
if ($useProxy) { Write-Host "using proxy $proxy" } else { Write-Host 'no proxy, going direct' }

function Get-Duration([string]$file) {
  $log = Join-Path $tmpDir 'probe.txt'
  & ffprobe -v error -show_entries format=duration -of csv=p=0 $file > $log 2>$null
  $v = 0.0
  if (Test-Path $log) {
    $s = ((Get-Content $log -Raw) -replace '\s', '')
    if ([double]::TryParse($s, [ref]$v)) { return $v }
  }
  return 0.0
}

# ffmpeg writes volumedetect to stderr; PowerShell's 2>&1 on a native command is
# unreliable here (it silently dropped the lines), so send the log to a file.
function Get-Levels([string]$file) {
  $log = Join-Path $tmpDir 'levels.txt'
  & ffmpeg -hide_banner -i $file -af volumedetect -f null NUL 2> $log
  $max = -3.0
  $mean = -20.0
  if (Test-Path $log) {
    $txt = Get-Content $log -Raw
    if ($txt -match 'max_volume:\s*(-?[\d.]+)') { $max = [double]$Matches[1] }
    if ($txt -match 'mean_volume:\s*(-?[\d.]+)') { $mean = [double]$Matches[1] }
  }
  return @{ max = $max; mean = $mean }
}

$total = 0
foreach ($name in $picks.Keys) {
  $id, $max = $picks[$name]
  $src = Join-Path $tmpDir "$name.mp3"
  $url = "https://assets.mixkit.co/active_storage/sfx/$id/$id-preview.mp3"

  if (-not (Test-Path $src)) {
    $args = @('-sSL', '--max-time', '40', '-A', 'Mozilla/5.0', '-o', $src)
    if ($useProxy) { $args += @('-x', $proxy) }
    $args += $url
    & curl.exe @args 2>$null | Out-Null
  }
  if (-not (Test-Path $src)) { Write-Host ("  {0,-8} DOWNLOAD FAILED" -f $name); continue }

  $dur = Get-Duration $src
  $len = [math]::Min($max, [math]::Max(0.2, $dur - 0.05))
  $fadeStart = [math]::Max(0, $len - 0.09)

  # Level-match with loudnorm rather than a flat gain.
  # These clips range from -14 to -32 dB mean; some (chewing, sparkles) are very
  # peaky, so a plain gain either leaves them inaudible or clips the transient.
  # loudnorm + a light compressor evens out the perceived loudness instead.
  # Target -18 LUFS / true peak -1.5 dBTP.
  $filter = "silenceremove=start_periods=1:start_silence=0.02:start_threshold=-50dB," +
            "atrim=0:$len,asetpts=N/SR/TB," +
            "acompressor=threshold=-20dB:ratio=2.5:attack=4:release=90," +
            "loudnorm=I=-18:TP=-1.5:LRA=11," +
            "afade=t=out:st=$fadeStart`:d=0.09"

  $dst = Join-Path $outDir "$name.mp3"
  $stage = Join-Path $tmpDir "$name.stage.wav"

  # pass 1: strip silence, trim, even out dynamics, loudnorm
  & ffmpeg -y -hide_banner -loglevel error -i $src -af $filter -ac 1 -ar 22050 $stage 2>&1 | Out-Null

  if (-not (Test-Path $stage)) { Write-Host ("  {0,-8} FFMPEG FAILED (pass 1)" -f $name); continue }

  # pass 2: loudnorm's single-pass mode is imprecise on very short clips
  # (chewing landed 14 dB below everything else), so measure the result and
  # apply one corrective gain, still respecting a -1 dB peak ceiling.
  $lv = Get-Levels $stage
  $gain = -20.0 - $lv.mean
  if (($lv.max + $gain) -gt -1.0) { $gain = -1.0 - $lv.max }
  $gain = [math]::Round($gain, 2)

  & ffmpeg -y -hide_banner -loglevel error -i $stage -af "volume=${gain}dB" `
    -ac 1 -ar 22050 -c:a libmp3lame -b:a 96k $dst 2>&1 | Out-Null
  Remove-Item $stage -Force -ErrorAction SilentlyContinue

  if (Test-Path $dst) {
    $kb = [math]::Round((Get-Item $dst).Length / 1KB, 1)
    $total += (Get-Item $dst).Length
    $lv2 = Get-Levels $dst
    Write-Host ("  {0,-8} id={1,-6} {2,5}s -> {3,5}s  fix {4,6}dB  peak {5,6}dB  mean {6,6}dB  {7,6} KB" -f `
      $name, $id, [math]::Round($dur, 2), [math]::Round($len, 2), $gain, $lv2.max, $lv2.mean, $kb)
  } else {
    Write-Host ("  {0,-8} FFMPEG FAILED (pass 2)" -f $name)
  }
}

Write-Host ("`ntotal {0} KB -> {1}" -f [math]::Round($total / 1KB), $outDir)
