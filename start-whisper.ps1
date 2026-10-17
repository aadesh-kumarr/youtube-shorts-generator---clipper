$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = Join-Path $projectRoot '.venv\Scripts\python.exe'

if (-not (Test-Path -LiteralPath $python)) {
  throw 'Python environment not found. Run: python -m venv .venv, then install whisper-service/requirements.txt.'
}

& $python (Join-Path $projectRoot 'whisper-service\server.py')
