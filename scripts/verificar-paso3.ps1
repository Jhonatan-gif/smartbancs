# Verificacion del Paso 3: ETL + ai-service + recomendaciones asincronas con fallback.
# Prueba clave: con el ai-service LENTO (5 s) o APAGADO, las transferencias siguen dando 201 sin cambiar su latencia
# y el endpoint de recomendaciones responde el fallback en < 500 ms.
# Requiere la pila levantada:  docker compose up --build -d
# Uso:  powershell -ExecutionPolicy Bypass -File scripts\verificar-paso3.ps1 [-SinTests]
param([switch]$SinTests)

. "$PSScriptRoot\lib-verificacion.ps1"
Set-Location $script:RepoRoot
Add-Type -AssemblyName System.Net.Http

$Ai = 'http://127.0.0.1:8000'
$Api = $script:CoreApi
$Cuentas = @(@('1000000016', '1000000032'), @('1000000032', '1000000016'))  # alternar sentido: el saldo casi no cambia
$run = [guid]::NewGuid().ToString('N').Substring(0, 8)

function Get-Percentile([double[]]$Valores, [double]$P) {
    $s = $Valores | Sort-Object
    $i = [math]::Min($s.Count - 1, [math]::Floor($s.Count * $P))
    return $s[$i]
}

# Hace N transferencias por HTTP real y devuelve codigos y latencias.
function Send-Transfers([int]$N, [string]$Tag) {
    $lat = @(); $codes = @()
    for ($i = 0; $i -lt $N; $i++) {
        $par = $Cuentas[$i % 2]
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $r = New-Transfer $par[0] $par[1] '1.00' "v3-$run-$Tag-$i" "p3-$Tag"
        $sw.Stop()
        $lat += $sw.Elapsed.TotalMilliseconds; $codes += $r.Status
    }
    return [pscustomobject]@{
        Ok = (@($codes | Where-Object { $_ -ne 201 }).Count -eq 0)
        P50 = [math]::Round((Get-Percentile $lat 0.5), 1)
        P95 = [math]::Round((Get-Percentile $lat 0.95), 1)
        Max = [math]::Round(($lat | Measure-Object -Maximum).Maximum, 1)
    }
}

function Get-Recs([string]$Account = '1000000016') {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $r = Invoke-Api GET "$Api/v1/accounts/$Account/recommendations"
    $sw.Stop()
    return [pscustomobject]@{ Status = $r.Status; Source = $r.Body.source; Reason = $r.Body.reason; Ms = [math]::Round($sw.Elapsed.TotalMilliseconds, 1); Body = $r.Body }
}

function Set-AiMode([string]$Mode, [int]$DelayMs = 5000) {
    return Invoke-Api POST "$Ai/admin/mode" -Body @{ mode = $Mode; delay_ms = $DelayMs }
}

try {
    Titulo 'Servicios'
    $svcs = Get-ComposeServices
    foreach ($n in @('postgres', 'redis', 'bancs-mock', 'core-api', 'ai-service')) {
        $s = $svcs | Where-Object { $_.Service -eq $n }
        Check "Servicio $n sano" ($null -ne $s -and $s.Health -eq 'healthy') "State=$($s.State) Health=$($s.Health)"
    }
    $w = $svcs | Where-Object { $_.Service -eq 'worker' }
    Check 'Servicio worker en ejecucion' ($null -ne $w -and $w.State -eq 'running')

    Titulo 'ai-service: modelo y consumo del stream'
    Set-AiMode 'normal' | Out-Null
    $h = (Invoke-Api GET "$Ai/health").Body
    Check 'ai-service sano, con modelo y features cargados' ($h.status -eq 'ok' -and $h.accountsWithHistory -gt 0) "modelo=$($h.model) cuentas=$($h.accountsWithHistory) features=$($h.featuresSource)"
    $grupos = (Invoke-Native -Exe 'docker' -Arguments @('compose', 'exec', '-T', 'redis', 'redis-cli', 'XINFO', 'GROUPS', 'transfers.completed')).Output
    Check 'Grupos independientes en el stream: ai-recs y bancs-sync' (($grupos -match 'ai-recs') -and ($grupos -match 'bancs-sync'))

    $antes = [int]$h.stream.processed
    $t = New-Transfer '1000000016' '1000000032' '3.00' "v3-$run-evento" 'p3-evento'
    $consumido = Wait-Until { [int](Invoke-Api GET "$Ai/health").Body.stream.processed -gt $antes } 20 500
    Check 'Una transferencia nueva llega al ai-service por el stream (asincrono)' ($t.Status -eq 201 -and $consumido) "procesados: $antes -> $((Invoke-Api GET "$Ai/health").Body.stream.processed)"

    Titulo 'Recomendaciones con todo sano'
    $r = Get-Recs
    Check 'GET /recommendations = 200 con source=model' ($r.Status -eq 200 -and $r.Source -eq 'model' -and $r.Body.degraded -eq $false) "modelo=$($r.Body.modelVersion) segmento=$($r.Body.segment) en $($r.Ms) ms"
    Check 'Trae entre 1 y 4 recomendaciones con titulo y mensaje' ($r.Body.recommendations.Count -ge 1 -and $r.Body.recommendations.Count -le 4 -and $r.Body.recommendations[0].title -and $r.Body.recommendations[0].message)
    $nf = Invoke-Api GET "$Api/v1/accounts/1000000099/recommendations"
    Check 'Cuenta inexistente = 404' ($nf.Status -eq 404) "HTTP $($nf.Status)"

    Titulo 'Referencia: transferencias con el ai-service sano'
    $base = Send-Transfers 40 'base'
    Check '40 transferencias = 201' $base.Ok "p50=$($base.P50) ms  p95=$($base.P95) ms  max=$($base.Max) ms"

    Titulo 'ai-service LENTO (5 s por respuesta)'
    Set-AiMode 'slow' 5000 | Out-Null
    # 40 consultas de recomendaciones en paralelo (sin esperar) mientras se hacen transferencias
    $http = New-Object System.Net.Http.HttpClient
    $http.Timeout = [TimeSpan]::FromSeconds(30)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $tareas = 1..40 | ForEach-Object { $http.GetAsync("$Api/v1/accounts/1000000016/recommendations") }
    $lento = Send-Transfers 40 'lento'
    [System.Threading.Tasks.Task]::WaitAll([System.Threading.Tasks.Task[]]$tareas)
    $sw.Stop()
    $codigos = $tareas | ForEach-Object { [int]$_.Result.StatusCode }
    $fuentes = $tareas | ForEach-Object { $_.Result.Headers.GetValues('x-recommendations-source') | Select-Object -First 1 }
    Check 'Las 40 transferencias siguen dando 201' $lento.Ok "p50=$($lento.P50) ms  p95=$($lento.P95) ms  max=$($lento.Max) ms (referencia: p50=$($base.P50) p95=$($base.P95))"
    Check 'La latencia p95 de las transferencias sigue < 2000 ms' ($lento.P95 -lt 2000) "p95=$($lento.P95) ms"
    Check 'Las 40 consultas de recomendaciones = 200 con fallback' ((@($codigos | Where-Object { $_ -ne 200 }).Count -eq 0) -and (@($fuentes | Where-Object { $_ -ne 'fallback' }).Count -eq 0)) "todas resueltas en $([math]::Round($sw.Elapsed.TotalSeconds, 2)) s (no esperaron los 5 s del ai-service)"
    $http.Dispose()
    $seq = 1..5 | ForEach-Object { Get-Recs }
    $maxSeq = ($seq | Measure-Object -Property Ms -Maximum).Maximum
    Check 'Fallback secuencial en < 500 ms (5 de 5)' ((@($seq | Where-Object { $_.Source -ne 'fallback' -or $_.Ms -ge 500 }).Count -eq 0)) "maximo=$maxSeq ms razones=$((($seq | ForEach-Object { $_.Reason }) | Select-Object -Unique) -join ',')"
    Check 'Con el circuito abierto el fallback es inmediato (< 100 ms)' ($seq[-1].Reason -eq 'circuit_open' -and $seq[-1].Ms -lt 100) "razon=$($seq[-1].Reason) en $($seq[-1].Ms) ms"

    Titulo 'ai-service APAGADO (contenedor detenido)'
    Set-AiMode 'normal' | Out-Null
    $procAntes = [int](Invoke-Api GET "$Ai/health").Body.stream.processed
    Invoke-Native -Exe 'docker' -Arguments @('compose', 'stop', 'ai-service') | Out-Null
    $apagado = Send-Transfers 30 'apagado'
    Check 'Con el ai-service apagado, 30 transferencias = 201' $apagado.Ok "p50=$($apagado.P50) ms  p95=$($apagado.P95) ms  max=$($apagado.Max) ms"
    $seq2 = 1..5 | ForEach-Object { Get-Recs }
    Check 'Recomendaciones = fallback en < 500 ms (5 de 5)' ((@($seq2 | Where-Object { $_.Status -ne 200 -or $_.Source -ne 'fallback' -or $_.Ms -ge 500 }).Count -eq 0)) "maximo=$(($seq2 | Measure-Object -Property Ms -Maximum).Maximum) ms"

    Titulo 'Recuperacion'
    Invoke-Native -Exe 'docker' -Arguments @('compose', 'start', 'ai-service') | Out-Null
    $vuelve = Wait-Until { $x = Invoke-Api GET "$Ai/health"; $x.Status -eq 200 } 60 1000
    Check 'El ai-service vuelve a estar sano' $vuelve
    $sirve = Wait-Until { (Get-Recs).Source -eq 'model' } 40 1500
    Check 'core-api vuelve a servir recomendaciones del modelo solo (breaker cerrado)' $sirve
    $alcanza = Wait-Until { [int](Invoke-Api GET "$Ai/health").Body.stream.processed -ge 30 } 30 1000
    Check 'Los eventos ocurridos mientras estuvo caido se procesan al volver (no se pierden)' $alcanza "procesados tras volver=$((Invoke-Api GET "$Ai/health").Body.stream.processed)"
    $dlq = (Invoke-Native -Exe 'docker' -Arguments @('compose', 'exec', '-T', 'redis', 'redis-cli', 'XLEN', 'transfers.dlq')).Output.Trim()
    Check 'La caida de la IA no afecto a Bancs: DLQ vacia' ($dlq -eq '0') "XLEN=$dlq"
}
finally {
    # Pase lo que pase, dejar el ai-service encendido y en modo normal
    Invoke-Native -Exe 'docker' -Arguments @('compose', 'start', 'ai-service') | Out-Null
    Wait-Until { (Invoke-Api GET "$Ai/health").Status -eq 200 } 40 1000 | Out-Null
    Set-AiMode 'normal' | Out-Null
}

if (-not $SinTests) {
    Titulo 'Pruebas automaticas'
    $t = Invoke-VitestSuite 'core-api'
    $ok = ($t.ExitCode -eq 0) -and ($t.Output -match 'Tests\s+25 passed') -and ($t.Output -notmatch '\d+ failed')
    Check '25 tests de core-api pasan (transferencias, IA, metricas, privacidad)' $ok (($t.Output -split "`n" | Where-Object { $_ -match '^\s*Tests\s' }) -join ' ')
    if (-not $ok) { Write-Host $t.Output }

    $py = Invoke-Native -Exe 'docker' -Arguments @('compose', 'exec', '-T', 'ai-service', 'python', '-m', 'pytest', '-q')
    Check '23 tests del ai-service pasan (motor, API, consumidor con Redis real, metricas)' ($py.ExitCode -eq 0 -and $py.Output -match '23 passed') (($py.Output -split "`n" | Select-Object -Last 1))
    if ($py.ExitCode -ne 0) { Write-Host $py.Output }

    $etl = Invoke-Native -Exe 'docker' -Arguments @('compose', 'run', '--rm', 'etl', 'python', '-m', 'pytest', '-q')
    Check '46 tests del ETL pasan' ($etl.ExitCode -eq 0 -and $etl.Output -match '46 passed') (($etl.Output -split "`n" | Select-Object -Last 1))
} else {
    Write-Host ''; Write-Host '  (tests omitidos con -SinTests)' -ForegroundColor Yellow
}

Resumen 'PASO 3'
