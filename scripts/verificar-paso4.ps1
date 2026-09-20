# Verificacion del Paso 4: observabilidad (metricas, logs con trace_id, dashboards, alertas y diagnostico del incidente).
# Requiere la pila con el perfil obs:  docker compose --profile obs up -d --build
# Uso:  powershell -ExecutionPolicy Bypass -File scripts\verificar-paso4.ps1 [-SinTests] [-SinDeadlock]
param([switch]$SinTests, [switch]$SinDeadlock)

. "$PSScriptRoot\lib-verificacion.ps1"
Set-Location $script:RepoRoot
Add-Type -AssemblyName System.Net.Http

$Prom = 'http://127.0.0.1:9090'
$Loki = 'http://127.0.0.1:3100'
$Graf = 'http://127.0.0.1:3001'
$Tempo = 'http://127.0.0.1:3200'
$Api = $script:CoreApi
$run = [guid]::NewGuid().ToString('N').Substring(0, 8)
$GrafHeaders = @{ Authorization = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes('admin:admin')) }

function Get-Metrics([string]$Url) {
    try { return (Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 10).Content } catch { return '' }
}

# Consulta instantanea a Prometheus; devuelve la suma de los valores (o $null si no hay serie).
function Get-PromValue([string]$Query) {
    $r = Invoke-Api GET "$Prom/api/v1/query?query=$([uri]::EscapeDataString($Query))"
    $res = @($r.Body.data.result)
    if ($res.Count -eq 0) { return $null }
    $sum = [double]0
    foreach ($x in $res) { $v = [double]::Parse($x.value[1], [System.Globalization.CultureInfo]::InvariantCulture); if (-not [double]::IsNaN($v)) { $sum += $v } }
    return $sum
}

# Busca lineas de log en Loki que contengan un texto (ultimos 15 min). Devuelve objetos {Service, Line}.
function Find-Logs([string]$Selector, [string]$Contains) {
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $q = "$Selector |= `"$Contains`""
    $url = "$Loki/loki/api/v1/query_range?query=$([uri]::EscapeDataString($q))&start=$(($now - 900))000000000&end=$(($now + 60))000000000&limit=50"
    $r = Invoke-Api GET $url
    $out = @()
    foreach ($s in @($r.Body.data.result)) { foreach ($v in $s.values) { $out += [pscustomobject]@{ Service = $s.stream.service; Line = $v[1] } } }
    return $out
}

# Devuelve los spans de una traza de Tempo como objetos {Service, Name, Ms, Error}
function Get-TraceSpans([string]$TraceId) {
    $r = Invoke-Api GET "$Tempo/api/traces/$TraceId"
    $spans = @()
    foreach ($rs in @($r.Body.batches)) {
        $svc = ($rs.resource.attributes | Where-Object { $_.key -eq 'service.name' }).value.stringValue
        foreach ($ss in @($rs.scopeSpans)) {
            foreach ($sp in @($ss.spans)) {
                $spans += [pscustomobject]@{ Service = $svc; Name = $sp.name; Ms = ([decimal]$sp.endTimeUnixNano - [decimal]$sp.startTimeUnixNano) / 1e6; Error = ($sp.status.code -eq 'STATUS_CODE_ERROR' -or $sp.status.code -eq 2) }
            }
        }
    }
    return $spans
}

function New-CrossedTransfers([int]$Rounds, [string]$Tag) {
    $http = New-Object System.Net.Http.HttpClient
    $http.Timeout = [TimeSpan]::FromSeconds(30)
    $codes = @()
    for ($i = 0; $i -lt $Rounds; $i++) {
        $tasks = @()
        foreach ($par in @(@('1000000016', '1000000032'), @('1000000032', '1000000016'))) {
            $req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, "$Api/v1/transfers")
            $req.Headers.Add('Idempotency-Key', "v4-$run-$Tag$i-$($par[0])")
            $req.Content = New-Object System.Net.Http.StringContent((@{ fromAccount = $par[0]; toAccount = $par[1]; amount = '1.00' } | ConvertTo-Json -Compress), [Text.Encoding]::UTF8, 'application/json')
            $tasks += $http.SendAsync($req)
        }
        [System.Threading.Tasks.Task]::WaitAll([System.Threading.Tasks.Task[]]$tasks)
        foreach ($t in $tasks) { $codes += [int]$t.Result.StatusCode }
    }
    $http.Dispose()
    return $codes
}

try {
    Titulo 'Servicios (perfil obs)'
    $svcs = Get-ComposeServices
    foreach ($n in @('postgres', 'redis', 'bancs-mock', 'core-api', 'worker', 'ai-service', 'prometheus', 'loki', 'grafana')) {
        $s = $svcs | Where-Object { $_.Service -eq $n }
        Check "Servicio $n sano" ($null -ne $s -and $s.Health -eq 'healthy') "State=$($s.State) Health=$($s.Health)"
    }
    foreach ($n in @('alloy', 'postgres-exporter', 'tempo')) {
        $s = $svcs | Where-Object { $_.Service -eq $n }
        Check "Servicio $n en ejecucion" ($null -ne $s -and $s.State -eq 'running') "State=$($s.State)"
    }

    Titulo 'Endpoints /metrics de cada servicio'
    $m = Get-Metrics "$Api/metrics"
    Check 'core-api /metrics: transferencias, pasos SQL, pool y HTTP' (($m -match 'transfers_total') -and ($m -match 'db_op_duration_seconds') -and ($m -match 'db_pool_connections') -and ($m -match 'http_request_duration_seconds') -and ($m -match 'service="core-api"'))
    $m = Get-Metrics 'http://127.0.0.1:9464/metrics'
    Check 'worker /metrics: Bancs, breaker, outbox, lag y DLQ' (($m -match 'bancs_calls_total|bancs_synced_total') -and ($m -match 'bancs_breaker_state') -and ($m -match 'outbox_unpublished_events') -and ($m -match 'stream_group_lag') -and ($m -match 'dlq_length'))
    $m = Get-Metrics 'http://127.0.0.1:8000/metrics'
    Check 'ai-service /metrics: recomendaciones, eventos y modo' (($m -match 'ai_recommendation_duration_seconds') -and ($m -match 'ai_stream_events_processed_total') -and ($m -match 'ai_admin_mode'))
    $wh = Invoke-Api GET 'http://127.0.0.1:9464/health'
    Check 'worker /health = 200 (healthcheck de Docker)' ($wh.Status -eq 200)

    Titulo 'Prometheus: targets y alertas'
    $tg = (Invoke-Api GET "$Prom/api/v1/targets").Body.data.activeTargets
    $caidos = @($tg | Where-Object { $_.health -ne 'up' })
    Check 'Los 5 targets estan UP (core-api, worker, ai-service, postgres, prometheus)' ($tg.Count -ge 5 -and $caidos.Count -eq 0) "targets=$($tg.Count) caidos=$(($caidos | ForEach-Object { $_.labels.job }) -join ',')"
    $grupos = (Invoke-Api GET "$Prom/api/v1/rules").Body.data.groups
    $reglas = @($grupos | ForEach-Object { $_.rules })
    $malas = @($reglas | Where-Object { $_.health -ne 'ok' })
    Check 'Reglas de alerta cargadas y validas (>= 12)' ($reglas.Count -ge 12 -and $malas.Count -eq 0) "reglas=$($reglas.Count) con error=$($malas.Count)"
    $necesarias = @('TransferLatencyP95High', 'TransferErrorRateHigh', 'DeadlocksDetected', 'DbPoolSaturated', 'BancsCircuitOpen', 'DeadLetterQueueNotEmpty', 'TargetDown')
    $faltan = @($necesarias | Where-Object { $n = $_; -not ($reglas | Where-Object { $_.name -eq $n }) })
    Check 'Estan las alertas clave del incidente (latencia, errores, deadlocks, pool, Bancs, DLQ)' ($faltan.Count -eq 0) "faltan: $($faltan -join ',')"

    Titulo 'Las metricas suben con trafico real'
    $baseCreated = Get-PromValue 'sum(transfers_total{outcome="created"})'; if ($null -eq $baseCreated) { $baseCreated = 0 }
    $baseSynced = Get-PromValue 'sum(bancs_synced_total)'; if ($null -eq $baseSynced) { $baseSynced = 0 }
    $trace = $null
    for ($i = 0; $i -lt 20; $i++) {
        $par = @(@('1000000016', '1000000032'), @('1000000032', '1000000016'))[$i % 2]
        $r = New-Transfer $par[0] $par[1] '1.00' "v4-$run-$i" "p4"
        if ($i -eq 19) { $trace = $r.Headers['x-request-id'] }
    }
    $rej = New-Transfer '1000000040' '1000000016' '999999.00' "v4-$run-fondos" 'p4'
    $rec = Invoke-Api GET "$Api/v1/accounts/1000000016/recommendations" -Headers @{ 'x-request-id' = "rec-$run" }
    $sube = Wait-Until { $c = Get-PromValue 'sum(transfers_total{outcome="created"})'; $null -ne $c -and $c -ge ($baseCreated + 20) } 60 2000
    Check 'transfers_total{created} sube en 20 (visto por Prometheus)' $sube "antes=$baseCreated ahora=$(Get-PromValue 'sum(transfers_total{outcome="created"})')"
    Check 'El rechazo por fondos aparece con su codigo (INSUFFICIENT_FUNDS)' ($rej.Status -eq 422 -and ((Get-PromValue 'sum(transfers_total{outcome="rejected",code="INSUFFICIENT_FUNDS"})') -ge 1))
    $ops = @('lock_accounts', 'insert_tx', 'debit', 'credit', 'ledger', 'outbox')
    $sinOps = @($ops | Where-Object { (Get-PromValue "sum(db_op_duration_seconds_count{op=`"$_`"})") -lt 20 })
    Check 'Cada paso SQL de la transferencia tiene su histograma' ($sinOps.Count -eq 0) "sin datos: $($sinOps -join ',')"
    $sincro = Wait-Until { $c = Get-PromValue 'sum(bancs_synced_total)'; $null -ne $c -and $c -ge ($baseSynced + 20) } 90 3000
    Check 'El worker reporta los movimientos sincronizados con Bancs' $sincro "sincronizados=$(Get-PromValue 'sum(bancs_synced_total)')"
    Check 'DLQ = 0 y ambos grupos del stream (bancs-sync, ai-recs) tienen lag medido' (((Get-PromValue 'dlq_length') -eq 0) -and ((Get-PromValue 'count(stream_group_lag)') -ge 2))
    Check 'postgres_exporter aporta deadlocks, sesiones y bloqueos' (($null -ne (Get-PromValue 'pg_stat_database_deadlocks{datname="smartbancs"}')) -and ($null -ne (Get-PromValue 'pg_stat_activity_count{datname="smartbancs"}')) -and ($null -ne (Get-PromValue 'pg_locks_count')))
    Check 'Metricas de IA: consulta del modelo registrada' ($rec.Status -eq 200 -and ((Get-PromValue 'sum(ai_calls_total)') -ge 1))

    Titulo 'Logs en Loki con trace_id (rastreo entre componentes)'
    $encontro = Wait-Until { $l = Find-Logs '{service=~"core-api|worker"}' $trace; (@($l | Where-Object { $_.Service -eq 'core-api' }).Count -ge 1) -and (@($l | Where-Object { $_.Service -eq 'worker' }).Count -ge 1) } 45 3000
    $lineas = Find-Logs '{service=~"core-api|worker"}' $trace
    Check 'Con el trace_id de UNA transferencia se ven sus logs en core-api Y en el worker' $encontro "trace_id=$trace servicios=$((($lineas | ForEach-Object { $_.Service }) | Select-Object -Unique) -join ',')"
    $wl = @($lineas | Where-Object { $_.Service -eq 'worker' -and $_.Line -match 'lote sincronizado con Bancs' })
    Check 'El worker registra el lote enviado a Bancs con los trace_id que contiene' ($wl.Count -ge 1)
    $ai = Wait-Until { @(Find-Logs '{service="ai-service"}' "rec-$run").Count -ge 1 } 45 3000
    Check 'El log del ai-service lleva el mismo trace_id que envio core-api' $ai "trace_id=rec-$run"
    $js = @($lineas | Where-Object { $_.Service -eq 'core-api' } | Select-Object -First 1)
    $okJson = $false; try { $null = $js[0].Line | ConvertFrom-Json; $okJson = $true } catch {}
    Check 'Los logs son JSON valido (una linea = un evento)' $okJson
    $pg = Wait-Until { @(Find-Logs '{service="postgres"}' 'LOG').Count -ge 1 } 30 2000
    Check 'Los logs de PostgreSQL tambien llegan a Loki' $pg

    Titulo 'Trazas distribuidas en Tempo (OpenTelemetry)'
    $spans = @()
    $completa = Wait-Until { $script:spans = @(Get-TraceSpans $trace); (@($script:spans | Where-Object { $_.Name -eq 'bancs.sync' }).Count -ge 1) } 60 3000
    $spans = @($script:spans)
    $nombres = ($spans | ForEach-Object { $_.Name }) -join ','
    Check 'La traza de UNA transferencia existe en Tempo y cruza core-api y worker' ($completa -and (@($spans | Where-Object { $_.Service -eq 'core-api' }).Count -ge 1) -and (@($spans | Where-Object { $_.Service -eq 'worker' }).Count -ge 1)) "trace_id=$trace spans=$($spans.Count)"
    $pasosTraza = @('db.lock_accounts', 'db.insert_tx', 'db.debit', 'db.credit', 'db.ledger', 'db.outbox')
    $faltanSpans = @($pasosTraza | Where-Object { $nombres -notmatch [regex]::Escape($_) })
    Check 'La traza muestra cada paso SQL como span propio' ($faltanSpans.Count -eq 0) "faltan: $($faltanSpans -join ',')"
    Check 'La traza sigue por el outbox y la sincronizacion con Bancs (outbox.publish, bancs.sync)' (($nombres -match 'outbox\.publish') -and ($nombres -match 'bancs\.sync'))
    Check 'El trace_id de los logs es el mismo de la traza (logs <-> trazas)' ((@($lineas | Where-Object { $_.Line -match [regex]::Escape($trace) }).Count -ge 1))

    Titulo 'Grafana: datasources y dashboards provisionados'
    foreach ($uid in @('prometheus', 'loki')) {
        $r = Invoke-Api GET "$Graf/api/datasources/uid/$uid/health" -Headers $GrafHeaders
        Check "Datasource $uid conectado" ($r.Status -eq 200 -and $r.Body.status -eq 'OK') "$($r.Body.message)"
    }
    # Tempo no implementa health check en el backend de Grafana (lo hace el navegador por el proxy): se prueba por el proxy.
    $te = Invoke-Api GET "$Graf/api/datasources/proxy/uid/tempo/api/echo" -Headers $GrafHeaders
    Check 'Datasource tempo conectado (Grafana llega a Tempo por su proxy)' ($te.Status -eq 200 -and $te.Raw -match 'echo') "HTTP $($te.Status)"
    $dbs = (Invoke-Api GET "$Graf/api/search?type=dash-db" -Headers $GrafHeaders).Body
    Check 'Dashboards Operacion e Incidente provisionados por archivos' ((@($dbs | Where-Object { $_.uid -in @('sb-operacion', 'sb-incidente') }).Count -eq 2))
    $total = 0; $fallan = @()
    foreach ($uid in @('sb-operacion', 'sb-incidente')) {
        $dash = (Invoke-Api GET "$Graf/api/dashboards/uid/$uid" -Headers $GrafHeaders).Body.dashboard
        foreach ($p in @($dash.panels | Where-Object { $_.targets })) {
            foreach ($t in $p.targets) {
                $total++
                if ($t.datasource.type -eq 'tempo') {
                    # Las busquedas TraceQL las ejecuta el navegador por el proxy del datasource: se replica esa misma llamada
                    $r = Invoke-Api GET "$Graf/api/datasources/proxy/uid/tempo/api/search?q=$([uri]::EscapeDataString($t.query))&limit=5" -Headers $GrafHeaders
                    if ($r.Status -ne 200 -or $null -eq $r.Body.PSObject.Properties['traces']) { $fallan += "[$uid] $($p.title): HTTP $($r.Status)" }
                    continue
                }
                $q = @{ refId = $t.refId; datasource = $t.datasource; expr = $t.expr; intervalMs = 15000; maxDataPoints = 200 }
                if ($t.datasource.type -eq 'loki') { $q.queryType = 'range'; $q.maxLines = 20 }
                $body = @{ queries = @($q); from = 'now-15m'; to = 'now' }
                $r = Invoke-Api POST "$Graf/api/ds/query" -Body $body -Headers $GrafHeaders
                $err = $r.Body.results.($t.refId).error
                if ($r.Status -ne 200 -or $err) { $fallan += "[$uid] $($p.title): $err" }
            }
        }
    }
    Check "Las $total consultas de todos los paneles se ejecutan sin error" ($total -gt 20 -and $fallan.Count -eq 0) ($fallan -join ' | ')
}
finally {
    # nada que restaurar aqui: el bloque del deadlock restaura core-api por su cuenta
}

if (-not $SinDeadlock) {
    Titulo 'Diagnostico del incidente 3.5: deadlock real con LOCK_ORDERING=off'
    try {
        $dl0 = Get-PromValue 'sum(db_errors_total{type="deadlock"})'; if ($null -eq $dl0) { $dl0 = 0 }
        $env:LOCK_ORDERING = 'off'; $env:SIMULATED_LOCK_DELAY_MS = '300'
        Invoke-Native -Exe 'docker' -Arguments @('compose', 'up', '-d', 'core-api') | Out-Null
        $up = Wait-Until { (Invoke-Api GET "$Api/health").Status -eq 200 } 60 1000
        Check 'core-api reiniciado con LOCK_ORDERING=off (solo para la demo)' $up
        $codes = New-CrossedTransfers 6 'off'
        $n409 = @($codes | Where-Object { $_ -eq 409 }).Count
        Check 'Transferencias cruzadas A<->B a la vez provocan deadlocks (HTTP 409)' ($n409 -ge 1) "409=$n409 de $($codes.Count) respuestas; el resto termino bien (201=$(@($codes | Where-Object { $_ -eq 201 }).Count))"
        $visto = Wait-Until { $c = Get-PromValue 'sum(db_errors_total{type="deadlock"})'; $null -ne $c -and $c -ge ($dl0 + 1) } 60 2000
        Check 'Prometheus ve los deadlocks (db_errors_total{type=deadlock})' $visto "antes=$dl0 ahora=$(Get-PromValue 'sum(db_errors_total{type="deadlock"})')"
        $porPaso = Get-PromValue 'sum(db_op_errors_total{pg_code="40P01"})'
        # Solo pasos con valor > 0 (las series inicializadas en 0 no cuentan)
        $pasos = ((Invoke-Api GET "$Prom/api/v1/query?query=$([uri]::EscapeDataString('sum by (op) (db_op_errors_total{pg_code="40P01"}) > 0'))").Body.data.result | ForEach-Object { $_.metric.op }) -join ','
        Check 'La metrica senala EL PASO SQL exacto donde ocurre el deadlock (lock_to: el segundo bloqueo)' ($pasos -eq 'lock_to') "paso(s) con deadlock: $pasos"
        $logs = Wait-Until { @(Find-Logs '{service="core-api"}' 'error SQL en el paso').Count -ge 1 } 45 3000
        $ll = @(Find-Logs '{service="core-api"}' 'error SQL en el paso') | Select-Object -First 1
        $detalle = ''; $conTrace = $false
        if ($ll) { $o = $ll.Line | ConvertFrom-Json; $detalle = "$($o.op) $($o.pg_code) $($o.type)"; $conTrace = [bool]$o.trace_id -and ([string]$o.detail -match 'Process') }
        Check 'El log del error trae paso, SQLSTATE 40P01, detalle de los procesos bloqueados y trace_id' ($logs -and $conTrace) $detalle
        $errTrace = Wait-Until { $x = Invoke-Api GET "$Tempo/api/search?q=$([uri]::EscapeDataString('{ name = "db.lock_to" && status = error }'))&limit=5"; @($x.Body.traces).Count -ge 1 } 60 3000
        Check 'En Tempo hay una traza con el span db.lock_to marcado como ERROR (el paso que hizo deadlock)' $errTrace
        $pgLog = Wait-Until { @(Find-Logs '{service="postgres"}' 'deadlock detected').Count -ge 1 } 45 3000
        Check 'El log de PostgreSQL registra "deadlock detected" (visible en Loki)' $pgLog
        $alertas = Wait-Until { @((Invoke-Api GET "$Prom/api/v1/alerts").Body.data.alerts | Where-Object { $_.labels.alertname -eq 'DeadlocksDetected' -and $_.state -eq 'firing' }).Count -ge 1 } 90 3000
        Check 'La alerta DeadlocksDetected se dispara en Prometheus' $alertas
    }
    finally {
        Remove-Item Env:LOCK_ORDERING -ErrorAction SilentlyContinue
        Remove-Item Env:SIMULATED_LOCK_DELAY_MS -ErrorAction SilentlyContinue
        Invoke-Native -Exe 'docker' -Arguments @('compose', 'up', '-d', 'core-api') | Out-Null
        Wait-Until { (Invoke-Api GET "$Api/health").Status -eq 200 } 60 1000 | Out-Null
    }
    $seguro = New-CrossedTransfers 3 'on'
    Check 'Restaurado LOCK_ORDERING=on: las mismas transferencias cruzadas ya no dan deadlock' (@($seguro | Where-Object { $_ -ne 201 }).Count -eq 0) "codigos=$($seguro -join ',')"
} else {
    Write-Host ''; Write-Host '  (prueba de deadlock omitida con -SinDeadlock)' -ForegroundColor Yellow
}

if (-not $SinTests) {
    Titulo 'Pruebas automaticas'
    $t = Invoke-VitestSuite 'core-api'
    $ok = ($t.ExitCode -eq 0) -and ($t.Output -match 'Tests\s+40 passed') -and ($t.Output -notmatch '\d+ failed')
    Check '40 tests de core-api pasan (transferencias, IA, metricas, diagnostico, privacidad y estados de cuenta)' $ok (($t.Output -split "`n" | Where-Object { $_ -match '^\s*Tests\s' }) -join ' ')
    if (-not $ok) { Write-Host $t.Output }
    $w = Invoke-VitestSuite 'worker'
    $okw = ($w.ExitCode -eq 0) -and ($w.Output -match 'Tests\s+10 passed') -and ($w.Output -notmatch '\d+ failed')
    Check '10 tests del worker pasan (7 previos + 3 de metricas)' $okw (($w.Output -split "`n" | Where-Object { $_ -match '^\s*Tests\s' }) -join ' ')
    if (-not $okw) { Write-Host $w.Output }
    $py = Invoke-Native -Exe 'docker' -Arguments @('compose', 'exec', '-T', 'ai-service', 'python', '-m', 'pytest', '-q')
    Check '23 tests del ai-service pasan' ($py.ExitCode -eq 0 -and $py.Output -match '23 passed') (($py.Output -split "`n" | Select-Object -Last 1))
} else {
    Write-Host ''; Write-Host '  (tests omitidos con -SinTests)' -ForegroundColor Yellow
}

Resumen 'PASO 4'
