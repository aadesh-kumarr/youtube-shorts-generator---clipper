$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = Join-Path $projectRoot '.venv\Scripts\python.exe'
$envFile = Join-Path $projectRoot '.env.local'

# Next.js loads .env.local automatically; Python does not. Import only the
# WHISPER_* values so both services share the same local model configuration.
if (Test-Path -LiteralPath $envFile) {
  Get-Content -LiteralPath $envFile | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith('#')) { return }
    $parts = $line -split '=', 2
    if ($parts.Count -ne 2) { return }
    $name = $parts[0].Trim()
    if ($name -notmatch '^WHISPER_[A-Z0-9_]+$') { return }
    $value = $parts[1].Trim().Trim('"').Trim("'")
    [Environment]::SetEnvironmentVariable($name, $value, 'Process')
  }
}

if (-not (Test-Path -LiteralPath $python)) {
  throw 'Python environment not found. Run: python -m venv .venv, then install whisper-service/requirements.txt.'
}

& $python (Join-Path $projectRoot 'whisper-service\server.py')
