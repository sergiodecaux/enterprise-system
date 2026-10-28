# Deploys ai-advisor to every account env in wrangler.toml.
#
# Auth per account (pick one):
#   * $env:CF_TOKEN_A / CF_TOKEN_B / ... — API token ("Edit Cloudflare Workers" template) for that account
#   * otherwise the current `npx wrangler login` session is used
#
# Optional: secrets are (re)written on every node from environment variables.
# A node-specific value wins over the shared one, e.g. GEMINI_API_KEY_A for env a.
#   ADVISOR_TOKEN, TELEGRAM_BOT_TOKEN, GEMINI_API_KEY, OPENROUTER_API_KEY, GROQ_API_KEY
#
#   powershell -ExecutionPolicy Bypass -File scripts/deploy-all.ps1 [-Envs a,b]

param(
  [string[]]$Envs = @('a', 'b', 'c', 'f')
)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$savedToken = $env:CLOUDFLARE_API_TOKEN
$failed = @()
$secretNames = @('ADVISOR_TOKEN', 'TELEGRAM_BOT_TOKEN', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY')

foreach ($name in $Envs) {
  $tokenVar = "CF_TOKEN_$($name.ToUpper())"
  $token = [Environment]::GetEnvironmentVariable($tokenVar)
  if ($token) { $env:CLOUDFLARE_API_TOKEN = $token } else { $env:CLOUDFLARE_API_TOKEN = $savedToken }

  Write-Host "=== ai-advisor env '$name' ($(if ($token) { $tokenVar } else { 'wrangler login' })) ===" -ForegroundColor Cyan
  try {
    npx wrangler deploy --env $name
    if ($LASTEXITCODE -ne 0) { throw "deploy exit $LASTEXITCODE" }

    foreach ($secretName in $secretNames) {
      $nodeVar = "$($secretName)_$($name.ToUpper())"
      $value = [Environment]::GetEnvironmentVariable($nodeVar)
      if (-not $value) { $value = [Environment]::GetEnvironmentVariable($secretName) }
      if ($value) {
        $value | npx wrangler secret put $secretName --env $name
        if ($LASTEXITCODE -ne 0) { throw "secret put $secretName exit $LASTEXITCODE" }
      }
    }
  } catch {
    Write-Host "!!! env '$name' failed: $_" -ForegroundColor Red
    $failed += $name
  }
}

$env:CLOUDFLARE_API_TOKEN = $savedToken

if ($failed.Count) {
  Write-Host "Failed: $($failed -join ', ')" -ForegroundColor Red
  exit 1
}
Write-Host 'All nodes deployed. Check each URL: <url>/health' -ForegroundColor Green
