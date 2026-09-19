# Funciones compartidas por verificar-paso1.ps1 y verificar-paso2.ps1
# (ASCII a proposito: Windows PowerShell 5.1 lee mal el UTF-8 sin BOM)

$script:Pass = 0
$script:Fail = 0
$script:CoreApi = 'http://127.0.0.1:3000'
$script:Bancs = 'http://127.0.0.1:4000'
$script:RepoRoot = Split-Path -Parent $PSScriptRoot

function Check([string]$Nombre, [bool]$Ok, [string]$Detalle = '') {
    if ($Ok) { $script:Pass++; Write-Host "  [PASS] $Nombre" -ForegroundColor Green }
    else { $script:Fail++; Write-Host "  [FAIL] $Nombre" -ForegroundColor Red }
    if ($Detalle) { Write-Host "         $Detalle" -ForegroundColor DarkGray }
}

function Titulo([string]$Texto) { Write-Host ""; Write-Host "== $Texto" -ForegroundColor Cyan }

function Resumen([string]$Paso) {
    Write-Host ""
    $total = $script:Pass + $script:Fail
    $color = 'Green'; if ($script:Fail -gt 0) { $color = 'Red' }
    Write-Host "$Paso : $($script:Pass)/$total chequeos OK, $($script:Fail) fallos" -ForegroundColor $color
    if ($script:Fail -gt 0) { exit 1 } else { exit 0 }
}

# Llamada HTTP que NUNCA lanza excepcion por 4xx/5xx: devuelve Status, Body (objeto) y Headers.
function Invoke-Api {
    param([string]$Method, [string]$Url, $Body = $null, [hashtable]$Headers = @{}, [int]$TimeoutSec = 30)
    $params = @{ Method = $Method; Uri = $Url; UseBasicParsing = $true; TimeoutSec = $TimeoutSec; Headers = $Headers }
    if ($null -ne $Body) {
        $params.Body = ($Body | ConvertTo-Json -Compress)
        $params.ContentType = 'application/json'
    }
    $status = 0; $text = ''; $hdrs = @{}
    try {
        $r = Invoke-WebRequest @params
        $status = [int]$r.StatusCode; $text = $r.Content; $hdrs = $r.Headers
    } catch {
        $resp = $_.Exception.Response
        if ($null -ne $resp) {
            $status = [int]$resp.StatusCode
            $hdrs = $resp.Headers
            # En PS 5.1 el cuerpo del error llega en ErrorDetails; en PS 7 tambien.
            if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $text = $_.ErrorDetails.Message }
            else {
                try {
                    $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
                    $text = $reader.ReadToEnd()
                } catch { $text = '' }
            }
        }
    }
    $obj = $null
    if ($text) { try { $obj = $text | ConvertFrom-Json } catch { $obj = $null } }
    return [pscustomobject]@{ Status = $status; Body = $obj; Raw = $text; Headers = $hdrs }
}

# Ejecuta un comando nativo y devuelve salida (stdout+stderr, sin colores ANSI) y codigo de salida.
function Invoke-Native {
    param([string]$Exe, [string[]]$Arguments, [string]$StdIn = $null)
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try {
        if ($null -ne $StdIn) { $lines = $StdIn | & $Exe @Arguments 2>&1 }
        else { $lines = & $Exe @Arguments 2>&1 }
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $prev }
    $text = (($lines | ForEach-Object { "$_" }) -join "`n") -replace '\x1b\[[0-9;?]*[A-Za-z]', ''
    return [pscustomobject]@{ Output = $text; ExitCode = $code }
}

# SQL dentro del contenedor de Postgres (no depende del puerto publicado en el PC).
function Invoke-Sql([string]$Sql) {
    $r = Invoke-Native -Exe 'docker' -Arguments @('compose', 'exec', '-T', 'postgres', 'psql', '-U', 'smartbancs', '-d', 'smartbancs', '-At', '-q') -StdIn $Sql
    return $r
}
function Get-SqlValue([string]$Sql) { return (Invoke-Sql $Sql).Output.Trim() }

# Estado de los contenedores del compose (acepta salida en JSON por lineas o como arreglo).
function Get-ComposeServices {
    $r = Invoke-Native -Exe 'docker' -Arguments @('compose', 'ps', '--all', '--format', 'json')
    $items = @()
    foreach ($line in ($r.Output -split "`n")) {
        $line = $line.Trim()
        if (-not $line.StartsWith('{') -and -not $line.StartsWith('[')) { continue }
        $parsed = $line | ConvertFrom-Json
        $items += @($parsed)
    }
    return $items
}

function Wait-Until([scriptblock]$Condicion, [int]$TimeoutSec = 60, [int]$PollMs = 1000) {
    $fin = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $fin) {
        if (& $Condicion) { return $true }
        Start-Sleep -Milliseconds $PollMs
    }
    return [bool](& $Condicion)
}

# Puerto real de Postgres publicado en el PC (5432 o 5433 segun .env)
function Get-DatabaseUrl {
    $r = Invoke-Native -Exe 'docker' -Arguments @('compose', 'port', 'postgres', '5432')
    $port = 5432
    if ($r.Output -match ':(\d+)\s*$') { $port = [int]$Matches[1] }
    return "postgres://smartbancs:smartbancs@localhost:$port/smartbancs"
}

# Dinero: siempre [decimal], nunca double.
function ConvertTo-Dec([string]$s) { return [decimal]::Parse($s, [System.Globalization.CultureInfo]::InvariantCulture) }
function Format-Dec([decimal]$d) { return $d.ToString('0.00', [System.Globalization.CultureInfo]::InvariantCulture) }

# Numero de cuenta valido (9 digitos + digito verificador Luhn), igual que el core-api.
function New-AccountNumber([string]$Body) {
    $sum = 0; $double = $true
    for ($i = $Body.Length - 1; $i -ge 0; $i--) {
        $d = [int][string]$Body[$i]
        if ($double) { $d *= 2; if ($d -gt 9) { $d -= 9 } }
        $sum += $d; $double = -not $double
    }
    return $Body + ((10 - ($sum % 10)) % 10)
}

function New-Transfer {
    param([string]$From, [string]$To, [string]$Amount, [string]$Key, [string]$Description = 'verificacion')
    return Invoke-Api -Method POST -Url "$($script:CoreApi)/v1/transfers" `
        -Body @{ fromAccount = $From; toAccount = $To; amount = $Amount; description = $Description } `
        -Headers @{ 'Idempotency-Key' = $Key }
}

# Ejecuta "npm test" en un servicio y devuelve la salida limpia de codigos ANSI.
function Invoke-VitestSuite([string]$Servicio, [string[]]$Archivos = @()) {
    $dir = Join-Path $script:RepoRoot "services\$Servicio"
    Push-Location $dir
    try {
        if (-not (Test-Path 'node_modules')) { Invoke-Native -Exe 'npm' -Arguments @('ci') | Out-Null }
        $env:DATABASE_URL = Get-DatabaseUrl
        return Invoke-Native -Exe 'npm' -Arguments (@('test', '--') + $Archivos)
    } finally { Pop-Location }
}
