# Busca el limite de una instancia: ejecuta escalones de tasa fija con k6 y mide CPU de cada contenedor durante la prueba.
# Uso:  powershell -ExecutionPolicy Bypass -File scripts\find-limit.ps1 -Rates 400,600,800,1000,1200 -Duration 30s
param([string]$Rates = '400,600,800,1000,1200', [string]$Duration = '30s')

. "$PSScriptRoot\lib-verificacion.ps1"
Set-Location $script:RepoRoot
$Evid = Join-Path $script:RepoRoot 'docs\evidencias'
Invoke-Sql (Get-Content (Join-Path $script:RepoRoot 'loadtest\seed-accounts.sql') -Raw) | Out-Null

$rows = @()
foreach ($rate in ($Rates -split ',' | ForEach-Object { [int]$_ })) {
    Write-Host "== escalon $rate tps durante $Duration" -ForegroundColor Cyan
    # muestreo de CPU de los contenedores a mitad de la prueba
    $job = Start-Job -ArgumentList $script:RepoRoot -ScriptBlock {
        Start-Sleep -Seconds 15
        Set-Location $args[0]
        docker stats --no-stream --format '{{.Name}} {{.CPUPerc}}' 2>&1
    }
    $k6out = & k6 run -e SCENARIO=fixed -e RATE=$rate -e DURATION=$Duration --summary-export (Join-Path $Evid "k6-fixed-$rate.json") (Join-Path $script:RepoRoot 'loadtest\transfers.js') 2>&1
    $stats = Receive-Job $job -Wait; Remove-Job $job
    $m = (Get-Content (Join-Path $Evid "k6-fixed-$rate.json") -Raw | ConvertFrom-Json).metrics
    $cpu = @{}
    # se suma el CPU de todas las replicas de cada servicio (core-api-1, core-api-2...)
    foreach ($l in @($stats)) { if ("$l" -match 'smartbancs-(\S+?)-\d+\s+([\d.]+)%') { $cpu[$Matches[1]] = [double]$cpu[$Matches[1]] + [double]$Matches[2] } }
    $dur = [double]($Duration -replace 's', '')
    $achieved = [math]::Round($m.transfers_created.count / $dur, 0)
    $row = [pscustomobject]@{
        objetivo_tps = $rate; logrado_tps = $achieved; p50_ms = [math]::Round($m.transfer_latency.med, 1)
        p95_ms = [math]::Round($m.transfer_latency.'p(95)', 1); p99_ms = [math]::Round($m.transfer_latency.'p(99)', 1)
        errores_pct = [math]::Round($m.transfer_errors.value * 100, 2)
        no_lanzadas = if ($m.dropped_iterations) { $m.dropped_iterations.count } else { 0 }
        cpu_core_api = [math]::Round($cpu['core-api'], 0); cpu_postgres = $cpu['postgres']; cpu_worker = $cpu['worker']
        cumple = (($m.transfer_latency.'p(95)' -lt 2000) -and ($m.transfer_errors.value -lt 0.01) -and (-not $m.dropped_iterations))
    }
    $rows += $row
    Write-Host ("   logrado={0} tps  p95={1} ms  errores={2} %  cpu core-api={3} % postgres={4} %  cumple={5}" -f $row.logrado_tps, $row.p95_ms, $row.errores_pct, $row.cpu_core_api, $row.cpu_postgres, $row.cumple)
    Start-Sleep -Seconds 8   # que el pool y las colas se vacien antes del siguiente escalon
}
$rows | Format-Table -AutoSize | Out-String | Write-Host
$rows | ConvertTo-Json | Out-File -Encoding utf8 (Join-Path $Evid 'k6-limite.json')
