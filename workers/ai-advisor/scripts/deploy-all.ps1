# Deploys ai-advisor to every account env in wrangler.toml.
#
# Auth per account (pick one):
#   * $env:CF_TOKEN_A / CF_TOKEN_B / ... — API token ("Edit Cloudflare Workers" template) for that account
#   * otherwise the current `npx wrangler login` session is used
#
# Optional: $env:ADVISOR_TOKEN — also (re)writes the ADVISOR_TOKEN secret on every node.
#
#   powershell -ExecutionPolicy Bypass -File scripts/deploy-all.ps1 [-Envs a,b]

param(
  [string[]]$Envs = @('a', 'b', 'c', 'f')
)

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$savedToken = $env:CLOUDFLARE_API_TOKEN
$failed = @()

foreach ($name in $Envs) {
  $tokenVar = "CF_TOKEN_$($name.ToUpper())"
  $token = [Environment]::GetEnvironmentVariable($tokenVar)
  if ($token) { $env:CLOUDFLARE_API_TOKEN = $token } else { $env:CLOUDFLARE_API_TOKEN = $savedToken }

  Write-Host "=== ai-advisor env '$name' ($(if ($token) { $tokenVar } else { 'wrangler login' })) ===" -ForegroundColor Cyan
  try {
    npx wrangler deploy --env $name
    if ($LASTEXITCODE -ne 0) { throw "deploy exit $LASTEXITCODE" }

    if ($env:ADVISOR_TOKEN) {
      $env:ADVISOR_TOKEN | npx wrangler secret put ADVISOR_TOKEN --env $name
      if ($LASTEXITCODE -ne 0) { throw "secret put exit $LASTEXITCODE" }
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
