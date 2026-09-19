# Verificacion del Paso 1 (core-api: transferencias atomicas, idempotentes, ledger).
# Requiere la pila levantada:  docker compose up --build -d
# Uso:  powershell -ExecutionPolicy Bypass -File scripts\verificar-paso1.ps1 [-SinTests]
param([switch]$SinTests)

. "$PSScriptRoot\lib-verificacion.ps1"
Set-Location $script:RepoRoot

$run = [guid]::NewGuid().ToString('N').Substring(0, 8)
$A = '1000000016'   # Ana, ahorros
$B = '1000000032'   # Luis, ahorros
$Bloqueada = '1000000057'
$Pobre = '1000000040'
$Inexistente = New-AccountNumber '999999999'

Titulo 'Servicio y contenedor'
$h = Invoke-Api GET "$($script:CoreApi)/health"
Check 'GET /health responde 200 con status ok' ($h.Status -eq 200 -and $h.Body.status -eq 'ok') "HTTP $($h.Status)"
$core = Get-ComposeServices | Where-Object { $_.Service -eq 'core-api' }
Check 'Contenedor core-api en estado healthy' ($null -ne $core -and $core.Health -eq 'healthy') "Health=$($core.Health)"

Titulo 'Consulta de cuenta'
$acc = Invoke-Api GET "$($script:CoreApi)/v1/accounts/$A"
Check 'GET cuenta existente = 200 con saldo decimal' ($acc.Status -eq 200 -and $acc.Body.balance -match '^\d+\.\d{2}$') "balance=$($acc.Body.balance)"
$nf = Invoke-Api GET "$($script:CoreApi)/v1/accounts/$Inexistente"
Check 'GET cuenta inexistente = 404' ($nf.Status -eq 404) "HTTP $($nf.Status)"

Titulo 'Validaciones (400 / 404 / 422)'
$r = Invoke-Api POST "$($script:CoreApi)/v1/transfers" -Body @{ fromAccount = $A; toAccount = $B; amount = '1.00' }
Check 'Sin Idempotency-Key = 400' ($r.Status -eq 400) "HTTP $($r.Status)"
$r = New-Transfer $A $B '0' "v1-$run-cero"
Check 'Monto 0 = 400' ($r.Status -eq 400) "HTTP $($r.Status)"
$r = New-Transfer $A $B '1.999' "v1-$run-dec"
Check 'Monto con 3 decimales = 400' ($r.Status -eq 400) "HTTP $($r.Status)"
$r = New-Transfer $A '1000000017' '1.00' "v1-$run-luhn"
Check 'Cuenta con digito verificador invalido = 400' ($r.Status -eq 400 -and $r.Body.error.code -eq 'INVALID_ACCOUNT_NUMBER') "HTTP $($r.Status)"
$r = New-Transfer $A $A '1.00' "v1-$run-misma"
Check 'Misma cuenta origen y destino = 400' ($r.Status -eq 400 -and $r.Body.error.code -eq 'SAME_ACCOUNT') "HTTP $($r.Status)"
$r = New-Transfer $A $Inexistente '1.00' "v1-$run-noexiste"
Check 'Cuenta destino inexistente = 404' ($r.Status -eq 404 -and $r.Body.error.code -eq 'ACCOUNT_NOT_FOUND') "HTTP $($r.Status)"
$r = New-Transfer $A $Bloqueada '1.00' "v1-$run-bloq"
Check 'Cuenta bloqueada = 422 ACCOUNT_NOT_ACTIVE' ($r.Status -eq 422 -and $r.Body.error.code -eq 'ACCOUNT_NOT_ACTIVE') "HTTP $($r.Status)"
$r = New-Transfer $Pobre $A '999999.00' "v1-$run-fondos"
Check 'Fondos insuficientes = 422 INSUFFICIENT_FUNDS' ($r.Status -eq 422 -and $r.Body.error.code -eq 'INSUFFICIENT_FUNDS') "HTTP $($r.Status)"

Titulo 'Transferencia e idempotencia'
$antesA = ConvertTo-Dec (Invoke-Api GET "$($script:CoreApi)/v1/accounts/$A").Body.balance
$antesB = ConvertTo-Dec (Invoke-Api GET "$($script:CoreApi)/v1/accounts/$B").Body.balance
$key = "v1-$run-ok"
$monto = '12.34'
$t1 = New-Transfer $A $B $monto $key
Check 'Primera transferencia = 201 (no replayed)' ($t1.Status -eq 201 -and $t1.Body.replayed -eq $false -and $t1.Body.status -eq 'COMPLETED') "HTTP $($t1.Status)"
$t2 = New-Transfer $A $B $monto $key
Check 'Misma clave y mismos datos = 200 replayed con el mismo id' ($t2.Status -eq 200 -and $t2.Body.replayed -eq $true -and $t2.Body.transactionId -eq $t1.Body.transactionId) "HTTP $($t2.Status)"
$t3 = New-Transfer $A $B '99.99' $key
Check 'Misma clave con datos distintos = 422 IDEMPOTENCY_KEY_REUSED' ($t3.Status -eq 422 -and $t3.Body.error.code -eq 'IDEMPOTENCY_KEY_REUSED') "HTTP $($t3.Status)"

$despA = ConvertTo-Dec (Invoke-Api GET "$($script:CoreApi)/v1/accounts/$A").Body.balance
$despB = ConvertTo-Dec (Invoke-Api GET "$($script:CoreApi)/v1/accounts/$B").Body.balance
$m = ConvertTo-Dec $monto
Check 'Saldo origen bajo exactamente una vez' (($antesA - $despA) -eq $m) "antes=$antesA despues=$despA esperado_delta=$m"
Check 'Saldo destino subio exactamente una vez' (($despB - $antesB) -eq $m) "antes=$antesB despues=$despB esperado_delta=$m"

Titulo 'Movimientos'
$mov = Invoke-Api GET "$($script:CoreApi)/v1/accounts/$A/movements?limit=5"
$primero = $null; if ($mov.Body.items) { $primero = @($mov.Body.items)[0] }
Check 'Movimientos = 200 y el ultimo es el debito recien hecho' ($mov.Status -eq 200 -and $null -ne $primero -and $primero.transactionId -eq $t1.Body.transactionId -and $primero.type -eq 'DEBIT' -and $primero.amount -eq $monto) "tipo=$($primero.type) monto=$($primero.amount)"
Check 'Movimiento trae saldo posterior y contraparte enmascarada' ($null -ne $primero -and $primero.balanceAfter -eq (Format-Dec $despA) -and $primero.counterparty -match '\*') "balanceAfter=$($primero.balanceAfter) contraparte=$($primero.counterparty)"
$movB = Invoke-Api GET "$($script:CoreApi)/v1/accounts/$B/movements?limit=1"
$pb = $null; if ($movB.Body.items) { $pb = @($movB.Body.items)[0] }
Check 'El destino ve el credito' ($null -ne $pb -and $pb.transactionId -eq $t1.Body.transactionId -and $pb.type -eq 'CREDIT') "tipo=$($pb.type)"
$nada = Get-SqlValue "SELECT count(*) FROM transactions WHERE idempotency_key = '$key';"
Check 'La clave idempotente genero una sola transaccion' ($nada -eq '1') "filas=$nada"

Titulo 'Consistencia del ledger'
$q = @'
SELECT count(*) FROM (
  SELECT transaction_id
    FROM ledger_entries
   GROUP BY transaction_id
  HAVING sum(CASE direction WHEN 'DEBIT' THEN amount ELSE -amount END) <> 0
      OR count(*) <> 2
) x;
'@
$desb = Get-SqlValue $q
Check 'Cada transaccion tiene 2 asientos y debitos = creditos' ($desb -eq '0') "transacciones descuadradas=$desb"
$q = @'
SELECT count(*) FROM accounts a
 WHERE EXISTS (SELECT 1 FROM ledger_entries l WHERE l.account_id = a.id)
   AND a.balance <> (SELECT l.balance_after FROM ledger_entries l WHERE l.account_id = a.id ORDER BY l.id DESC LIMIT 1);
'@
$desc = Get-SqlValue $q
Check 'Saldo de cada cuenta = balance_after de su ultimo asiento' ($desc -eq '0') "cuentas descuadradas=$desc"
$neg = Get-SqlValue "SELECT count(*) FROM accounts WHERE balance < 0;"
Check 'Ninguna cuenta con saldo negativo' ($neg -eq '0') "cuentas negativas=$neg"

Titulo 'Ledger inmutable'
$upd = Invoke-Sql "BEGIN; UPDATE ledger_entries SET amount = amount WHERE id = (SELECT min(id) FROM ledger_entries); ROLLBACK;"
Check 'UPDATE sobre ledger_entries es rechazado por el trigger' ($upd.Output -match 'append-only') ($upd.Output -split "`n" | Select-Object -First 1)
$del = Invoke-Sql "BEGIN; DELETE FROM ledger_entries WHERE id = (SELECT min(id) FROM ledger_entries); ROLLBACK;"
Check 'DELETE sobre ledger_entries es rechazado por el trigger' ($del.Output -match 'append-only') ($del.Output -split "`n" | Select-Object -First 1)

if (-not $SinTests) {
    Titulo 'Tests de core-api (vitest)'
    $t = Invoke-VitestSuite 'core-api' @('test/transfers.concurrency.test.ts')
    $ok = ($t.ExitCode -eq 0) -and ($t.Output -match 'Tests\s+8 passed') -and ($t.Output -notmatch '\d+ failed')
    $resumen = ($t.Output -split "`n" | Where-Object { $_ -match '^\s*(Tests|Test Files)\s' }) -join ' | '
    Check '8 tests pasan (concurrencia, idempotencia, deadlocks)' $ok $resumen
    if (-not $ok) { Write-Host $t.Output }
} else {
    Write-Host ''; Write-Host '  (tests omitidos con -SinTests)' -ForegroundColor Yellow
}

Resumen 'PASO 1'
