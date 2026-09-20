# Prueba de carga con k6 + comprobaciones de correccion posteriores (el dinero se conserva, el ledger cuadra, sin duplicados).
# Requiere la pila levantada y k6 instalado (o Docker: se usa la imagen grafana/k6 si no hay k6 local).
# Uso:  powershell -ExecutionPolicy Bypass -File scripts\run-loadtest.ps1 -Scenario smoke|load|ramp|hot
param(
    [ValidateSet('smoke', 'load', 'ramp', 'hot', 'fixed')][string]$Scenario = 'smoke',
    [int]$Rate = 500,
    [string]$Duration = '30s',
    [switch]$SinSeed
)

. "$PSScriptRoot\lib-verificacion.ps1"
Set-Location $script:RepoRoot
$Evid = Join-Path $script:RepoRoot 'docs\evidencias'
New-Item -ItemType Directory -Force $Evid | Out-Null
$Name = if ($Scenario -eq 'fixed') { "fixed-$Rate" } else { $Scenario }
$summary = Join-Path $Evid "k6-$Name.json"
$textOut = Join-Path $Evid "k6-$Name.txt"

Titulo "Preparacion ($Scenario)"
if (-not $SinSeed) {
    $r = Invoke-Sql (Get-Content (Join-Path $script:RepoRoot 'loadtest\seed-accounts.sql') -Raw)
    Write-Host "  cuentas de carga: $($r.Output.Trim())"
}
$LoadFilter = "account_id IN (SELECT id FROM accounts WHERE customer_id = (SELECT id FROM customers WHERE email = 'carga@example.com'))"
$totalAntes = Get-SqlValue "SELECT sum(balance) FROM accounts WHERE customer_id = (SELECT id FROM customers WHERE email = 'carga@example.com');"
$txAntes = [int](Get-SqlValue "SELECT count(*) FROM transactions WHERE description = 'k6';")
$sincAntes = [int](Get-SqlValue "SELECT count(*) FROM bancs_sync WHERE status = 'SYNCED';")
Write-Host "  saldo total de las cuentas de carga antes: $totalAntes"

Titulo "k6: escenario $Scenario"
$k6 = Get-Command k6 -ErrorAction SilentlyContinue
$inicio = Get-Date
if ($k6) {
    $args2 = @('run', '-e', "SCENARIO=$Scenario", '-e', "RATE=$Rate", '-e', "DURATION=$Duration", '--summary-export', $summary, (Join-Path $script:RepoRoot 'loadtest\transfers.js'))
    $res = Invoke-Native -Exe 'k6' -Arguments $args2
} else {
    Write-Host '  (k6 no esta instalado: se usa la imagen grafana/k6 de Docker)'
    $args2 = @('run', '--rm', '-i', '-v', "$($script:RepoRoot)\loadtest:/loadtest", '-v', "${Evid}:/out", '-e', "SCENARIO=$Scenario", '-e', "RATE=$Rate", '-e', "DURATION=$Duration",
        '-e', 'BASE_URL=http://host.docker.internal:3000', 'grafana/k6', 'run', '--summary-export', "/out/k6-$Name.json", '/loadtest/transfers.js')
    $res = Invoke-Native -Exe 'docker' -Arguments $args2
}
$fin = Get-Date
# se quitan las lineas de progreso ('running (10.0s)...') para que la evidencia sea legible
(($res.Output -split "`n") | Where-Object { $_ -notmatch '^\s*running \(' }) -join "`n" | Out-File -Encoding utf8 $textOut
($res.Output -split "`n" | Where-Object { $_ -match 'transfer_latency|transfer_errors|http_reqs|dropped_iterations|checks\.|thresholds|✓|✗|iterations|vus_max|transfers_' }) | ForEach-Object { Write-Host "  $_" }
Write-Host "  codigo de salida de k6: $($res.ExitCode) (0 = umbrales cumplidos)"

Titulo 'Correccion despues de la carga'
$s = Get-Content $summary -Raw | ConvertFrom-Json
$m = $s.metrics
$creadas = [int]$m.transfers_created.count
$repet = [int]$m.transfers_replayed.count
$txDespues = [int](Get-SqlValue "SELECT count(*) FROM transactions WHERE description = 'k6';")
Check 'Cada transferencia creada por k6 existe UNA sola vez en la base (las repeticiones idempotentes no duplican)' (($txDespues - $txAntes) -eq $creadas) "k6 creo=$creadas filas nuevas=$($txDespues - $txAntes) repeticiones enviadas=$repet"
$totalDespues = Get-SqlValue "SELECT sum(balance) FROM accounts WHERE customer_id = (SELECT id FROM customers WHERE email = 'carga@example.com');"
Check 'El dinero se conserva: el saldo total de las cuentas de carga no cambia' ((ConvertTo-Dec $totalAntes) -eq (ConvertTo-Dec $totalDespues)) "antes=$totalAntes despues=$totalDespues"
$desb = Get-SqlValue @'
SELECT count(*) FROM (SELECT transaction_id FROM ledger_entries GROUP BY transaction_id
 HAVING sum(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END) <> 0 OR count(*) <> 2) x;
'@
Check 'Ledger: cada transaccion tiene 2 asientos y debitos = creditos' ($desb -eq '0') "descuadradas=$desb"
$desc = Get-SqlValue @'
SELECT count(*) FROM accounts a WHERE EXISTS (SELECT 1 FROM ledger_entries l WHERE l.account_id = a.id)
 AND a.balance <> (SELECT l.balance_after FROM ledger_entries l WHERE l.account_id = a.id ORDER BY l.id DESC LIMIT 1);
'@
Check 'Ledger: el saldo de cada cuenta coincide con su ultimo asiento' ($desc -eq '0') "descuadradas=$desc"
$cadena = Get-SqlValue @'
SELECT count(*) FROM (
  SELECT balance_after, lag(balance_after) OVER (PARTITION BY account_id ORDER BY id) AS previo,
         CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END AS delta
    FROM ledger_entries) t
 WHERE previo IS NOT NULL AND balance_after <> previo + delta;
'@
Check 'Ledger: la cadena de saldos de cada cuenta es continua (cada asiento = saldo anterior +/- monto)' ($cadena -eq '0') "saltos=$cadena"
$neg = Get-SqlValue 'SELECT count(*) FROM accounts WHERE balance < 0;'
Check 'Ninguna cuenta con saldo negativo' ($neg -eq '0') "negativas=$neg"

Titulo 'Resultados medidos'
$dur = [math]::Round(($fin - $inicio).TotalSeconds, 0)
$p95 = [math]::Round($m.transfer_latency.'p(95)', 1)
Write-Host ("  Duracion: {0} s | peticiones: {1} | tasa media: {2} req/s" -f $dur, $m.http_reqs.count, [math]::Round($m.http_reqs.rate, 1))
Write-Host ("  Latencia de transferencias: avg={0} ms  p90={1} ms  p95={2} ms  p99={3} ms  max={4} ms" -f [math]::Round($m.transfer_latency.avg, 1), [math]::Round($m.transfer_latency.'p(90)', 1), $p95, [math]::Round($m.transfer_latency.'p(99)', 1), [math]::Round($m.transfer_latency.max, 1))
Write-Host ("  Errores (5xx/409/sin respuesta): {0} %" -f [math]::Round($m.transfer_errors.value * 100, 3))
if ($m.dropped_iterations) { Write-Host ("  Iteraciones que k6 NO pudo lanzar (el sistema no dio abasto): {0}" -f $m.dropped_iterations.count) }

Titulo 'Sincronizacion con Bancs tras la carga (el legado no es el cuello de botella de la API)'
$pend = [int](Get-SqlValue "SELECT count(*) FROM transactions t WHERE NOT EXISTS (SELECT 1 FROM bancs_sync s WHERE s.transaction_id = t.id AND s.status = 'SYNCED');")
$t0 = Get-Date; $sync0 = [int](Get-SqlValue "SELECT count(*) FROM bancs_sync WHERE status = 'SYNCED';")
Start-Sleep -Seconds 20
$sync1 = [int](Get-SqlValue "SELECT count(*) FROM bancs_sync WHERE status = 'SYNCED';")
$rate = [math]::Round(($sync1 - $sync0) / ((Get-Date) - $t0).TotalSeconds, 1)
Write-Host "  pendientes de sincronizar con Bancs: $pend | ritmo medido de sincronizacion: $rate movimientos/s"
if ($rate -gt 0) { Write-Host ("  tiempo estimado para vaciar la cola a ese ritmo: {0} min" -f [math]::Round($pend / $rate / 60, 1)) }
[pscustomobject]@{
    escenario = $Scenario; fecha = (Get-Date).ToString('s'); duracion_s = $dur; k6_exit = $res.ExitCode
    requests = $m.http_reqs.count; req_por_s = [math]::Round($m.http_reqs.rate, 1)
    p50_ms = [math]::Round($m.transfer_latency.med, 1); p95_ms = $p95; p99_ms = [math]::Round($m.transfer_latency.'p(99)', 1)
    errores_pct = [math]::Round($m.transfer_errors.value * 100, 3); iteraciones_no_lanzadas = if ($m.dropped_iterations) { $m.dropped_iterations.count } else { 0 }
    creadas = $creadas; repeticiones = $repet; pendientes_bancs = $pend; sync_por_s = $rate
} | ConvertTo-Json | Out-File -Encoding utf8 (Join-Path $Evid "k6-$Name-resumen.json")

Resumen "CARGA $Scenario"
