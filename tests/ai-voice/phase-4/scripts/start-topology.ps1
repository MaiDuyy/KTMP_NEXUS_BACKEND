param(
  [ValidateSet('up', 'down', 'ps', 'logs', 'preflight')]
  [string]$Command = 'up'
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$composeFile = Join-Path $repositoryRoot 'tests\ai-voice\phase-4\topology\docker-compose.p4c.yml'
$values = @{}

Get-Content (Join-Path $repositoryRoot '.env') | ForEach-Object {
  if ($_ -match '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
    $values[$matches[1]] = $matches[2]
  }
}

function Require-EnvironmentValue([string]$Name) {
  if ([string]::IsNullOrWhiteSpace($values[$Name])) {
    throw "Missing required value '$Name' in $repositoryRoot\\.env"
  }
  return $values[$Name]
}

$env:P4C_JWT_SECRET = Require-EnvironmentValue 'JWT_SECRET'
$env:P4C_LIVEKIT_URL = Require-EnvironmentValue 'LIVEKIT_URL'
$env:P4C_LIVEKIT_API_KEY = Require-EnvironmentValue 'LIVEKIT_API_KEY'
$env:P4C_LIVEKIT_API_SECRET = Require-EnvironmentValue 'LIVEKIT_API_SECRET'
$env:P4C_GOOGLE_CLOUD_PROJECT = Require-EnvironmentValue 'GOOGLE_CLOUD_PROJECT'
$env:P4C_GOOGLE_CLOUD_LOCATION = Require-EnvironmentValue 'GOOGLE_CLOUD_LOCATION'
$env:P4C_GOOGLE_STT_MODEL = Require-EnvironmentValue 'GOOGLE_STT_MODEL'
$env:P4C_GOOGLE_STT_LANGUAGE = Require-EnvironmentValue 'GOOGLE_STT_LANGUAGE'
$env:P4C_GOOGLE_TTS_VOICE = Require-EnvironmentValue 'GOOGLE_TTS_VOICE'
$env:P4C_GOOGLE_TTS_AUDIO_ENCODING = Require-EnvironmentValue 'GOOGLE_TTS_AUDIO_ENCODING'
$env:P4C_GEMINI_API_KEY = Require-EnvironmentValue 'GOOGLE_CLOUD_API_KEY'
$env:P4C_GCLOUD_CONFIG_DIR = Join-Path $env:APPDATA 'gcloud'
$env:P4C_BACKEND_NETWORK = 'ktmp_nexus_backend_ott-network'

# These credentials are scoped to a local P4-C run and never persisted to disk.
$env:P4C_VOICE_TURN_TOKEN_SECRET = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
$env:P4C_VOICE_INTERNAL_SERVICE_KEY = [guid]::NewGuid().ToString('N')
$env:P4C_MEETING_AI_INTERNAL_SERVICE_KEY = [guid]::NewGuid().ToString('N')

$composeArgs = @('-p', 'p4c', '-f', $composeFile)
switch ($Command) {
  'up' { & docker compose @composeArgs up --build -d }
  'down' { & docker compose @composeArgs down }
  'ps' { & docker compose @composeArgs ps }
  'logs' { & docker compose @composeArgs logs --tail 200 }
  'preflight' {
    if ([string]::IsNullOrWhiteSpace($env:P4C_FRONTEND_URL)) { $env:P4C_FRONTEND_URL = 'http://localhost:3002' }
    $env:P4C_GATEWAY_URL = 'http://localhost:3100/healthz'
    $env:P4C_VOICE_SERVICE_URL = 'http://localhost:3035/healthz'
    $env:P4C_AI_KNOWLEDGE_URL = 'http://localhost:8080/healthz'
    if ([string]::IsNullOrWhiteSpace($env:P4C_LIVEKIT_HTTP_URL)) {
      $env:P4C_LIVEKIT_HTTP_URL = $env:P4C_LIVEKIT_URL -replace '^wss://', 'https://' -replace '^ws://', 'http://'
    }
    & node (Join-Path $repositoryRoot 'tests\ai-voice\phase-4\scripts\preflight.mjs')
  }
}
