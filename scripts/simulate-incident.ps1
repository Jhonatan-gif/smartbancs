# SIMULACION REPRODUCIBLE DEL INCIDENTE DE QUINCENA (reto 3.5): latencia alta, timeouts de conexion y deadlocks.
#
# Fases (cada una se mide con k6 sobre unas pocas cuentas "calientes" con transferencias cruzadas A<->B):
#   1. LINEA BASE   LOCK_ORDERING=on  (comportamiento normal)
#   2. INCIDENTE    LOCK_ORDERING=off + retraso entre bloqueos + pool pequeno (la regresion que "llega a produccion")
#      - durante la carga se toma el DIAGNOSTICO en vivo (sesiones bloqueadas, quien bloquea a quien)
#      - MITIGACION TEMPORAL: se intentan terminar sesiones bloqueadas (aqui no hay: PostgreSQL resuelve el deadlock solo)
#        y se revierte el cambio, que es la mitigacion que de verdad funciona
#   3. CORRECCION   LOCK_ORDERING=on otra vez (fix definitivo: bloqueo siempre en orden de id)
#
# Uso:  powershell -ExecutionPolicy Bypass -File scripts\simulate-incident.ps1 [-Rate 120] [-Duration 40s]
param([int]$Rate = 120, [string]$Duration = '40s', [int]$HotAccounts = 6)

. "$PSScriptRoot\lib-verificacion.ps1"
Set-Location $script:RepoRoot
$Evid = Join-Path $script:RepoRoot 'docs\evidencias'
$Api = $script:CoreApi
Invoke-Sql (Get-Content (Join-Path $script:RepoRoot 'loadtest\seed-accounts.sql') -Raw) | Out-Null

function Restart-CoreApi([hashtable]$EnvVars) {
    foreach ($k in $EnvVars.Keys) { Set-Item "Env:$k" $EnvVars[$k] }
    Invoke-Native -Exe 'docker' -Arguments @('compose', 'up', '-d', 'core-api') | Out-Null
    foreach ($k in $EnvVars.Keys) { Remove-Item "Env:$k" -ErrorAction SilentlyContinue }
    $ok = Wait-Until { (Invoke-Api GET "$Api/health").Status -eq 200 } 60 1000
    if (-not $ok) { throw 'core-api no volvio a estar sano' }
    Start-Sleep -Seconds 3   # pool precalentado
}

# Suma de una serie de /metrics de core-api (los contadores se reinician con cada reinicio: son de la fase actual)
function Get-Counter([string]$Name, [string]$Filter = '') {
    $body = (Invoke-WebRequest -UseBasicParsing "$Api/metrics").Content
    $t = [double]0
    foreach ($l in ($body -split "`n")) {
        if (($l.StartsWith("$Name{") -or $l.StartsWith("$Name ")) -and ($Filter -eq '' -or $l.Contains($Filter))) { $t += [double]($l.Split(' ')[-1]) }
    }
    return $t
}

function Run-Phase([string]$Name, [string]$Titulo, [scriptblock]$Durante = $null) {
    Titulo $Titulo
    $summary = Join-Path $Evid "incidente-$Name.json"
    $job = Start-Job -ArgumentList $script:RepoRoot, $Rate, $Duration, $HotAccounts, $summary -ScriptBlock {
        param($root, $rate, $dur, $acc, $out)
        Set-Location $root
        & k6 run -e SCENARIO=fixed -e RATE=$rate -e DURATION=$dur -e ACCOUNTS=$acc --summary-export $out (Join-Path $root 'loadtest\transfers.js') 2>&1 | Out-Null
    }
    if ($Durante) { Start-Sleep -Seconds 15; & $Durante }
    Receive-Job $job -Wait | Out-Null; Remove-Job $job
    $m = (Get-Content $summary -Raw | ConvertFrom-Json).metrics
    $r = [pscustomobject]@{
        Fase = $Name
        Tps = [math]::Round(($m.transfers_created.count + $m.transfers_rejected.count) / ([double]($Duration -replace 's', '')), 0)
        P50ms = [math]::Round($m.transfer_latency.med, 0); P95ms = [math]::Round($m.transfer_latency.'p(95)', 0); P99ms = [math]::Round($m.transfer_latency.'p(99)', 0)
        ErroresPct = [math]::Round($m.transfer_errors.value * 100, 1)
        Deadlocks = [int](Get-Counter 'db_errors_total' 'type="deadlock"')
        PoolTimeouts = [int](Get-Counter 'db_errors_total' 'type="pool_timeout"')
        LockTimeouts = [int](Get-Counter 'db_errors_total' 'type="lock_timeout"')
    }
    Write-Host ("  tps={0} p50={1} ms p95={2} ms p99={3} ms errores={4} % deadlocks={5} pool_timeouts={6} lock_timeouts={7}" -f $r.Tps, $r.P50ms, $r.P95ms, $r.P99ms, $r.ErroresPct, $r.Deadlocks, $r.PoolTimeouts, $r.LockTimeouts)
    return $r
}

$Cli = "customer_id = (SELECT id FROM customers WHERE email = 'carga@example.com')"
$totalAntes = Get-SqlValue "SELECT sum(balance) FROM accounts WHERE $Cli;"
$txAntes = [int](Get-SqlValue "SELECT count(*) FROM transactions;")
$results = @()
$Normal = @{ LOCK_ORDERING = 'on'; SIMULATED_LOCK_DELAY_MS = '0'; DB_POOL_MAX = '20' }
$Incidente = @{ LOCK_ORDERING = 'off'; SIMULATED_LOCK_DELAY_MS = '150'; DB_POOL_MAX = '8' }
$diag = @()

try {
    Restart-CoreApi $Normal
    $results += Run-Phase 'linea-base' "1. LINEA BASE (LOCK_ORDERING=on, pool 20) - $Rate tps sobre $HotAccounts cuentas calientes"

    Restart-CoreApi $Incidente
    $results += Run-Phase 'incidente' '2. INCIDENTE (LOCK_ORDERING=off, retraso 150 ms entre bloqueos, pool 8)' {
        Write-Host '  --- DIAGNOSTICO EN VIVO (durante la carga) ---' -ForegroundColor Yellow
        $script:diag += "pool esperando (metrica db_pool_connections{state=waiting}): $([int](Get-Counter 'db_pool_connections' 'state="waiting"'))"
        $script:diag += "deadlocks acumulados hasta ahora (db_errors_total): $([int](Get-Counter 'db_errors_total' 'type="deadlock"'))"
        $sesiones = (Invoke-Sql "SELECT coalesce(wait_event_type,'-') || '/' || coalesce(wait_event,'-') || ' -> ' || count(*) FROM pg_stat_activity WHERE datname='smartbancs' AND state <> 'idle' AND pid <> pg_backend_pid() GROUP BY wait_event_type, wait_event ORDER BY count(*) DESC;").Output.Trim()
        $script:diag += "sesiones activas por evento de espera de PostgreSQL:`n      " + ($sesiones -replace "`n", "`n      ")
        $bloq = (Invoke-Sql "SELECT 'pid ' || blocked.pid || ' espera a pid ' || blocking.pid || ' | bloqueada: ' || left(regexp_replace(blocked.query, '\s+', ' ', 'g'), 70) FROM pg_stat_activity blocked JOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) AS b(pid) ON true JOIN pg_stat_activity blocking ON blocking.pid = b.pid WHERE blocked.datname='smartbancs' LIMIT 5;").Output.Trim()
        $script:diag += "quien bloquea a quien (pg_blocking_pids):`n      " + ($bloq -replace "`n", "`n      ")
        $porPaso = foreach ($op in @('lock_accounts', 'lock_from', 'lock_to', 'insert_tx', 'debit', 'credit')) {
            $f = 'op="' + $op + '"'
            "$op=" + [int](Get-Counter 'db_op_errors_total' $f)
        }
        $script:diag += "errores por paso SQL (db_op_errors_total): " + ($porPaso -join ' ') + "  <- los errores estan en los pasos de BLOQUEO (lock_from / lock_to), no en las escrituras: el problema es el orden de los bloqueos"
        $script:diag | ForEach-Object { Write-Host "  $_" }
        Write-Host '  --- MITIGACION TEMPORAL 1: terminar sesiones bloqueadas por mas de 1 s ---' -ForegroundColor Yellow
        $n = (Invoke-Sql "SELECT count(*) FROM (SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='smartbancs' AND wait_event_type='Lock' AND now() - state_change > interval '1 second' AND pid <> pg_backend_pid()) t;").Output.Trim()
        if ($n -eq '0') { Write-Host "  sesiones terminadas: 0 -> no habia bloqueos largos: PostgreSQL ya resuelve cada deadlock a los 500 ms (deadlock_timeout). El dano no viene de sesiones colgadas sino del POOL saturado y de las peticiones que reintentan." }
        else { Write-Host "  sesiones terminadas: $n (alivia el sintoma, pero NO la causa: los deadlocks vuelven mientras el codigo bloquee en desorden)" }
        Write-Host '  --- MITIGACION TEMPORAL 2 (la que funciona): revertir el cambio / apagar el flag -> fase 3 ---' -ForegroundColor Yellow
        $script:diag += "sesiones terminadas como mitigacion temporal: $n"
    }

    Restart-CoreApi $Normal
    $results += Run-Phase 'correccion' '3. CORRECCION DEFINITIVA (LOCK_ORDERING=on: bloqueo siempre en orden de id)'
}
finally {
    Restart-CoreApi $Normal
}

Titulo 'RESUMEN (medido)'
$results | Format-Table Fase, Tps, P50ms, P95ms, P99ms, ErroresPct, Deadlocks, PoolTimeouts, LockTimeouts -AutoSize | Out-String | Write-Host
$results | ConvertTo-Json | Out-File -Encoding utf8 (Join-Path $Evid 'incidente-resultado.json')
$diag | Out-File -Encoding utf8 (Join-Path $Evid 'incidente-diagnostico.txt')

$base = $results[0]; $inc = $results[1]; $fix = $results[2]
Check 'Linea base sana: p95 < 2 s, errores < 1 %, 0 deadlocks' (($base.P95ms -lt 2000) -and ($base.ErroresPct -lt 1) -and ($base.Deadlocks -eq 0)) "p95=$($base.P95ms) ms errores=$($base.ErroresPct) %"
Check 'El incidente se reproduce: deadlocks y errores' (($inc.Deadlocks -ge 1) -and ($inc.ErroresPct -gt 1)) "deadlocks=$($inc.Deadlocks) errores=$($inc.ErroresPct) %"
Check 'El incidente degrada la latencia (p95 mayor que la linea base)' ($inc.P95ms -gt $base.P95ms) "p95 $($base.P95ms) ms -> $($inc.P95ms) ms"
Check 'Tras la correccion: 0 deadlocks' ($fix.Deadlocks -eq 0) "deadlocks=$($fix.Deadlocks)"
Titulo 'CORRECCION DEL DINERO DESPUES DEL INCIDENTE (deadlocks, timeouts y reintentos no pierden ni duplican dinero)'
$totalDespues = Get-SqlValue "SELECT sum(balance) FROM accounts WHERE $Cli;"
$txNuevas = [int](Get-SqlValue "SELECT count(*) FROM transactions;") - $txAntes
Check 'El saldo total de las cuentas de carga se conserva' ((ConvertTo-Dec $totalAntes) -eq (ConvertTo-Dec $totalDespues)) "antes=$totalAntes despues=$totalDespues (transacciones nuevas en las 3 fases: $txNuevas)"
Check 'Cada transaccion tiene 2 asientos y debitos = creditos' ((Get-SqlValue "SELECT count(*) FROM (SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING sum(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END) <> 0 OR count(*) <> 2) x;") -eq '0')
Check 'El saldo de cada cuenta coincide con su ultimo asiento' ((Get-SqlValue "SELECT count(*) FROM accounts a WHERE EXISTS (SELECT 1 FROM ledger_entries l WHERE l.account_id = a.id) AND a.balance <> (SELECT l.balance_after FROM ledger_entries l WHERE l.account_id = a.id ORDER BY l.id DESC LIMIT 1);") -eq '0')
Check 'La cadena de saldos de cada cuenta es continua' ((Get-SqlValue "SELECT count(*) FROM (SELECT balance_after, lag(balance_after) OVER (PARTITION BY account_id ORDER BY id) AS previo, CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END AS delta FROM ledger_entries) t WHERE previo IS NOT NULL AND balance_after <> previo + delta;") -eq '0')
Check 'Ninguna cuenta con saldo negativo y ninguna clave idempotente duplicada' (((Get-SqlValue 'SELECT count(*) FROM accounts WHERE balance < 0;') -eq '0') -and ((Get-SqlValue 'SELECT count(*) FROM (SELECT idempotency_key FROM transactions GROUP BY 1 HAVING count(*) > 1) x;') -eq '0'))

Check 'Tras la correccion: p95 < 2 s y errores < 1 %' (($fix.P95ms -lt 2000) -and ($fix.ErroresPct -lt 1)) "p95=$($fix.P95ms) ms errores=$($fix.ErroresPct) %"
Resumen 'INCIDENTE'
