# Verificacion del Paso 2 (worker + Redis Streams + bancs-mock: lotes, rate limit, breaker, DLQ).
# Requiere la pila levantada:  docker compose up --build -d
# Uso:  powershell -ExecutionPolicy Bypass -File scripts\verificar-paso2.ps1 [-SinTests]
param([switch]$SinTests)

. "$PSScriptRoot\lib-verificacion.ps1"
Set-Location $script:RepoRoot

$run = [guid]::NewGuid().ToString('N').Substring(0, 8)
$A = '1000000016'
$B = '1000000032'
$Bancs = $script:Bancs

# Envia N transferencias alternando sentido (el saldo casi no cambia) con montos distintos.
# Devuelve codigos HTTP, latencia maxima y el neto esperado por cuenta.
function Send-Batch([int]$Cantidad, [string]$Tag) {
    $codes = @(); $maxMs = 0; $netA = [decimal]0
    for ($i = 1; $i -le $Cantidad; $i++) {
        $monto = [decimal]$i / 100 + 1          # 1.01, 1.02, ...
        $txt = Format-Dec $monto
        if ($i % 2 -eq 1) { $from = $A; $to = $B; $netA -= $monto } else { $from = $B; $to = $A; $netA += $monto }
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $r = New-Transfer $from $to $txt "v2-$run-$Tag-$i" $Tag
        $sw.Stop()
        $codes += $r.Status
        if ($sw.ElapsedMilliseconds -gt $maxMs) { $maxMs = $sw.ElapsedMilliseconds }
    }
    return [pscustomobject]@{ Codes = $codes; MaxMs = $maxMs; NetA = $netA }
}

function Get-SyncedCount([string]$Tag) {
    $v = Get-SqlValue "SELECT count(*) FROM bancs_sync s JOIN transactions t ON t.id = s.transaction_id WHERE s.status = 'SYNCED' AND t.description = '$Tag';"
    return [int]$v
}

function Get-BancsStats { return (Invoke-Api GET "$Bancs/bancs/stats").Body }

# POST con cuerpo JSON (Fastify rechaza POST sin Content-Type json) y comprobacion de que quedo en cero.
function Reset-Bancs {
    $r = Invoke-Api POST "$Bancs/bancs/admin/reset" -Body @{}
    $st = Get-BancsStats
    return ($r.Status -eq 200 -and $st.postingsApplied -eq 0 -and $st.calls -eq 0)
}

try {
    Titulo 'Servicios'
    $esperados = @('postgres', 'redis', 'bancs-mock', 'core-api', 'worker')
    $svcs = Get-ComposeServices
    foreach ($n in $esperados) {
        $s = $svcs | Where-Object { $_.Service -eq $n }
        # El worker no expone healthcheck: para el "running" basta y luego se prueba con trafico real.
        if ($n -eq 'worker') { $ok = ($null -ne $s -and $s.State -eq 'running') }
        else { $ok = ($null -ne $s -and $s.Health -eq 'healthy') }
        Check "Servicio $n sano" $ok "State=$($s.State) Health=$($s.Health)"
    }

    Titulo 'Preparacion'
    Invoke-Api POST "$Bancs/bancs/admin/outage" -Body @{ down = $false } | Out-Null
    $drenado = Wait-Until { [int](Get-SqlValue "SELECT count(*) FROM transactions t WHERE EXISTS (SELECT 1 FROM outbox_events o WHERE o.aggregate_id = t.id) AND NOT EXISTS (SELECT 1 FROM bancs_sync s WHERE s.transaction_id = t.id AND s.status = 'SYNCED');") -eq 0 } 90
    Check 'No quedan transferencias previas pendientes de sincronizar' $drenado
    Check 'Contadores de Bancs puestos a cero (reset)' (Reset-Bancs)

    Titulo 'Sincronizacion normal: 30 transferencias'
    $tag1 = "p2-normal-$run"
    $b1 = Send-Batch 30 $tag1
    $todos201 = (@($b1.Codes | Where-Object { $_ -ne 201 }).Count -eq 0)
    Check 'La API responde 201 en las 30 transferencias' $todos201 "latencia maxima=$($b1.MaxMs) ms"
    Check 'Latencia maxima de la API < 2000 ms' ($b1.MaxMs -lt 2000) "$($b1.MaxMs) ms"
    $sync1 = Wait-Until { (Get-SyncedCount $tag1) -eq 30 } 120
    Check 'Las 30 terminan en SYNCED (bancs_sync)' $sync1 "SYNCED=$(Get-SyncedCount $tag1)"
    $st = Get-BancsStats
    Check 'Bancs aplico exactamente 30 movimientos' ($st.postingsApplied -eq 30) "aplicados=$($st.postingsApplied)"
    Check 'Bancs tiene 30 referencias unicas (sin duplicados aplicados)' ($st.uniqueReferences -eq 30) "unicas=$($st.uniqueReferences) duplicados_rechazados=$($st.postingsDuplicate)"
    Check 'Bancs no devolvio ningun 429 (rate limit ni sobrecarga)' (($st.rateLimited + $st.overloaded) -eq 0) "rateLimited=$($st.rateLimited) overloaded=$($st.overloaded) maxLlamadasPorSegundo=$($st.maxCallsPerSecond) maxEnParalelo=$($st.maxInFlight)"
    $netBancs = ConvertTo-Dec (Invoke-Api GET "$Bancs/bancs/accounts/$A").Body.net
    Check 'Conciliacion: neto de la cuenta en Bancs = neto enviado' ($netBancs -eq $b1.NetA) "bancs=$netBancs esperado=$($b1.NetA)"

    Titulo 'Caida simulada de Bancs'
    Check 'Contadores de Bancs puestos a cero antes de la caida' (Reset-Bancs)
    $base = Get-BancsStats
    Invoke-Api POST "$Bancs/bancs/admin/outage" -Body @{ down = $true } | Out-Null
    $tag2 = "p2-caida-$run"
    $b2 = Send-Batch 20 $tag2
    Check 'Con Bancs caido la API sigue respondiendo 201 (20/20)' (@($b2.Codes | Where-Object { $_ -ne 201 }).Count -eq 0) "latencia maxima=$($b2.MaxMs) ms"
    Write-Host '         (esperando 15 s con Bancs caido para medir al circuit breaker...)' -ForegroundColor DarkGray
    Start-Sleep -Seconds 15
    $durante = Get-BancsStats
    $llamadas = $durante.calls - $base.calls
    Check 'El circuit breaker limita las llamadas a Bancs (< 15)' ($llamadas -lt 15) "llamadas recibidas por Bancs en ~15 s de caida=$llamadas"
    Check 'Bancs caido no aplico ningun movimiento' ($durante.postingsApplied -eq 0) "aplicados=$($durante.postingsApplied)"
    Check 'Sin Bancs, las transferencias siguen sin SYNCED (no se pierden ni se marcan como hechas)' ((Get-SyncedCount $tag2) -eq 0)

    Titulo 'Recuperacion automatica'
    Invoke-Api POST "$Bancs/bancs/admin/outage" -Body @{ down = $false } | Out-Null
    $sync2 = Wait-Until { (Get-SyncedCount $tag2) -eq 20 } 120
    Check 'Al volver Bancs, las 20 pendientes pasan a SYNCED solas' $sync2 "SYNCED=$(Get-SyncedCount $tag2)"
    $fin = Get-BancsStats
    Check 'Bancs aplico exactamente 20 (sin duplicados)' (($fin.postingsApplied -eq 20) -and ($fin.uniqueReferences -eq 20)) "aplicados=$($fin.postingsApplied) unicas=$($fin.uniqueReferences)"
    Check 'Bancs no devolvio 429 durante la recuperacion' (($fin.rateLimited + $fin.overloaded) -eq 0) "rateLimited=$($fin.rateLimited) overloaded=$($fin.overloaded)"
    $netBancs2 = ConvertTo-Dec (Invoke-Api GET "$Bancs/bancs/accounts/$A").Body.net
    Check 'Conciliacion tras la recuperacion: neto en Bancs = neto enviado' ($netBancs2 -eq $b2.NetA) "bancs=$netBancs2 esperado=$($b2.NetA)"

    Titulo 'Dead-letter queue'
    $dlq = Invoke-Native -Exe 'docker' -Arguments @('compose', 'exec', '-T', 'redis', 'redis-cli', 'XLEN', 'transfers.dlq')
    Check 'La DLQ (transfers.dlq) esta vacia' ($dlq.Output.Trim() -eq '0') "XLEN=$($dlq.Output.Trim())"
    $failed = Get-SqlValue "SELECT count(*) FROM bancs_sync WHERE status = 'FAILED';"
    Check 'Ninguna transferencia en estado FAILED' ($failed -eq '0') "FAILED=$failed"
}
finally {
    # Pase lo que pase, dejar a Bancs encendido
    Invoke-Api POST "$Bancs/bancs/admin/outage" -Body @{ down = $false } | Out-Null
}

if (-not $SinTests) {
    Titulo 'Tests del worker (vitest)'
    $t = Invoke-VitestSuite 'worker' @('test/pipeline.integration.test.ts', 'test/resilience.unit.test.ts')
    $ok = ($t.ExitCode -eq 0) -and ($t.Output -match 'Tests\s+7 passed') -and ($t.Output -notmatch '\d+ failed')
    $resumen = ($t.Output -split "`n" | Where-Object { $_ -match '^\s*(Tests|Test Files)\s' }) -join ' | '
    Check '7 tests del worker pasan' $ok $resumen
    if (-not $ok) { Write-Host $t.Output }
} else {
    Write-Host ''; Write-Host '  (tests omitidos con -SinTests)' -ForegroundColor Yellow
}

Resumen 'PASO 2'
