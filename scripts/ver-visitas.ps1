<#
  Consulta rapida por consola de "quien accede" a la API de purpleair-saladillo,
  sin abrir el navegador (los endpoints admin van por header, no se pueden abrir
  pegando la URL). Requiere la ADMIN_KEY que generaste con `wrangler secret put ADMIN_KEY`.

  Uso:
    .\ver-visitas.ps1                       -> resumen (24h, 7d, top rutas, top paises)
    .\ver-visitas.ps1 -Modo visitas         -> ultimas 200 visitas, una por una
    .\ver-visitas.ps1 -Modo visitas -Limit 50

  La clave se puede pasar con -Key, o dejarla puesta una vez en la sesion de
  PowerShell asi no la volves a tipear:
    $env:PA_ADMIN_KEY = "tu_clave_real"
  (esto dura solo mientras esa ventana de PowerShell este abierta; si la queres
  fija de una vez para siempre, se agrega a tu perfil de PowerShell -avisame si
  la queres asi-)
#>
param(
    [ValidateSet("resumen", "visitas")]
    [string]$Modo = "resumen",
    [int]$Limit = 200,
    [string]$Key = $env:PA_ADMIN_KEY
)

$ApiBase = "https://purpleair-saladillo-api.fisicai-eureka-01.workers.dev"

if (-not $Key) {
    $secure = Read-Host "Admin key" -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    $Key = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

$headers = @{ "X-Admin-Key" = $Key }

if ($Modo -eq "resumen") {
    $url = "$ApiBase/api/admin/resumen"
} else {
    $url = "$ApiBase/api/admin/visitas?limit=$Limit"
}

try {
    $resp = Invoke-RestMethod -Uri $url -Headers $headers -ErrorAction Stop
} catch {
    Write-Host "Error consultando la API: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

if ($Modo -eq "resumen") {
    Write-Host ""
    Write-Host "Visitas ultimas 24h:   $($resp.visitas_ultimas_24h)" -ForegroundColor Cyan
    Write-Host "Visitas ultimos 7 dias: $($resp.visitas_ultimos_7d)" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Top rutas (7 dias):"
    $resp.top_paths_7d | Format-Table -AutoSize
    Write-Host "Top paises (7 dias):"
    $resp.top_paises_7d | Format-Table -AutoSize
} else {
    $resp | Format-Table -AutoSize -Wrap
}
