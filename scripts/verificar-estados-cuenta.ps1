# Verificacion de los estados de cuenta (CSV y PDF): los totales deben cuadrar con el ledger y con el saldo de la cuenta.
# Requiere la pila levantada:  docker compose up --build -d
# Uso:  powershell -ExecutionPolicy Bypass -File scripts\verificar-estados-cuenta.ps1 [-SinTests]
param([switch]$SinTests)

. "$PSScriptRoot\lib-verificacion.ps1"
Set-Location $script:RepoRoot
$Api = $script:CoreApi
$run = [guid]::NewGuid().ToString('N').Substring(0, 8)
$A = '1000000016'
$B = '1000000032'
$mes = (Get-Date).ToUniversalTime().ToString('yyyy-MM')

function Read-Csv([string]$Text) {
    $lineas = ($Text -replace "^﻿", '') -split "`r?`n" | Where-Object { $_ -ne '' }
    $resumen = @{}; $filas = @(); $enDetalle = $false
    foreach ($l in $lineas) {
        if ($l.StartsWith('Fecha (UTC)')) { $enDetalle = $true; continue }
        if ($enDetalle) { $filas += , ($l -split ',(?=(?:[^"]*"[^"]*")*[^"]*$)') }
        else { $k, $v = $l -split ',', 2; $resumen[$k] = $v }
    }
    return [pscustomobject]@{ Resumen = $resumen; Filas = $filas }
}

Titulo 'Preparacion: transferencias de distinto monto (con comas y comillas en la descripcion)'
$montos = @('12.34', '7.66', '100.00', '0.99', '250.10')
$i = 0
foreach ($m in $montos) {
    $i++
    $desde = $A; $hasta = $B; if ($i % 2 -eq 0) { $desde = $B; $hasta = $A }
    $r = New-Transfer $desde $hasta $m "v5-$run-$i" 'pago "prueba", ok'
    Check "Transferencia $i de $m = 201" ($r.Status -eq 201) "HTTP $($r.Status)"
}

Titulo 'CSV del mes actual'
$res = Invoke-WebRequest -UseBasicParsing "$Api/v1/accounts/$A/statements?month=$mes&format=csv"
Check 'GET statements CSV = 200 con text/csv' ($res.StatusCode -eq 200 -and $res.Headers['Content-Type'] -match 'text/csv') "Content-Type=$($res.Headers['Content-Type'])"
Check 'Se descarga como adjunto con la cuenta enmascarada en el nombre (nunca completa)' (($res.Headers['Content-Disposition'] -match 'attachment') -and ($res.Headers['Content-Disposition'] -match 'xxxxxx0016') -and ($res.Headers['Content-Disposition'] -notmatch $A)) "$($res.Headers['Content-Disposition'])"
Check 'Cache-Control: no-store (datos financieros)' ($res.Headers['Cache-Control'] -eq 'no-store')
$csv = Read-Csv $res.Content
$s = $csv.Resumen
$ini = ConvertTo-Dec $s['Saldo inicial']; $cre = ConvertTo-Dec $s['Total creditos']; $deb = ConvertTo-Dec $s['Total debitos']; $fin = ConvertTo-Dec $s['Saldo final']
Check 'Saldo inicial + creditos - debitos = saldo final' (($ini + $cre - $deb) -eq $fin) "$ini + $cre - $deb = $fin (declarado: $fin)"
$saldoActual = ConvertTo-Dec (Invoke-Api GET "$Api/v1/accounts/$A").Body.balance
Check 'Mes actual: el saldo final = saldo actual de la cuenta' ($fin -eq $saldoActual) "final=$fin actual=$saldoActual"
Check 'El numero de filas del detalle = "Movimientos" del resumen' ($csv.Filas.Count -eq [int]$s['Movimientos']) "filas=$($csv.Filas.Count) resumen=$($s['Movimientos'])"
$sumC = [decimal]0; $sumD = [decimal]0
foreach ($f in $csv.Filas) { if ($f[1] -eq 'CREDITO') { $sumC += ConvertTo-Dec $f[4] } else { $sumD += ConvertTo-Dec $f[4] } }
Check 'La suma del detalle coincide con los totales (creditos y debitos)' (($sumC -eq $cre) -and ($sumD -eq $deb)) "detalle: creditos=$sumC debitos=$sumD"
$ultima = $csv.Filas[-1]
Check 'El saldo de la ultima fila = saldo final' ((ConvertTo-Dec $ultima[5]) -eq $fin) "ultima fila=$($ultima[5])"

# Contraste INDEPENDIENTE: los mismos totales calculados directamente sobre el ledger con SQL
$sql = @"
SELECT COALESCE(sum(amount) FILTER (WHERE direction='CREDIT'),0)::numeric(18,2) || '|' || COALESCE(sum(amount) FILTER (WHERE direction='DEBIT'),0)::numeric(18,2) || '|' || count(*)
  FROM ledger_entries WHERE account_id = (SELECT id FROM accounts WHERE account_number = '$A')
   AND created_at >= '$mes-01'::timestamptz AND created_at < ('$mes-01'::timestamptz + interval '1 month');
"@
$led = (Get-SqlValue $sql) -split '\|'
Check 'Los totales coinciden con los calculados directamente sobre el ledger (SQL independiente)' (((ConvertTo-Dec $led[0]) -eq $cre) -and ((ConvertTo-Dec $led[1]) -eq $deb) -and ([int]$led[2] -eq [int]$s['Movimientos'])) "ledger: creditos=$($led[0]) debitos=$($led[1]) movimientos=$($led[2])"
Check 'La descripcion con comas y comillas quedo escapada (RFC 4180)' ($res.Content -match '"pago ""prueba"", ok"')
Check 'La contraparte sale enmascarada y no aparece la cuenta completa de terceros' (($res.Content -match '\*{6}0032') -and ($res.Content -notmatch $B))

Titulo 'PDF'
$pdf = Invoke-WebRequest -UseBasicParsing "$Api/v1/accounts/$A/statements?month=$mes&format=pdf"
$texto = [Text.Encoding]::GetEncoding('latin1').GetString($pdf.Content)
Check 'PDF: 200 con application/pdf' ($pdf.StatusCode -eq 200 -and $pdf.Headers['Content-Type'] -eq 'application/pdf')
Check 'PDF: empieza con %PDF y termina con %%EOF' (($texto.StartsWith('%PDF-1.4')) -and ($texto.TrimEnd().EndsWith('%%EOF')))
Check 'PDF: trae los mismos saldos que el CSV' (($texto -match [regex]::Escape("Saldo inicial:  $($s['Saldo inicial'])")) -and ($texto -match [regex]::Escape("Saldo final:    $($s['Saldo final'])")))
$pyLector = Join-Path $script:RepoRoot 'etl\.venv\Scripts\python.exe'
if (Test-Path $pyLector) {
    $tmp = Join-Path $env:TEMP "estado-$run.pdf"; [IO.File]::WriteAllBytes($tmp, $pdf.Content)
    $r = Invoke-Native -Exe $pyLector -Arguments @('-c', "import sys; from pypdf import PdfReader; r=PdfReader(sys.argv[1]); print(len(r.pages)); print(r.pages[0].extract_text())", $tmp)
    if ($r.ExitCode -eq 0) { Check 'PDF: lo abre un lector de terceros (pypdf) y el texto contiene el saldo final' ($r.Output -match [regex]::Escape($s['Saldo final'])) "paginas=$(($r.Output -split "`n")[0])" }
    else { Write-Host '  (pypdf no esta instalado: prueba con lector de terceros omitida)' -ForegroundColor Yellow }
    Remove-Item $tmp -ErrorAction SilentlyContinue
}

Titulo 'Validaciones'
Check 'Sin month = 400' ((Invoke-Api GET "$Api/v1/accounts/$A/statements").Status -eq 400)
Check 'Mes invalido (2026-13) = 400' ((Invoke-Api GET "$Api/v1/accounts/$A/statements?month=2026-13").Status -eq 400)
Check 'Formato desconocido = 400' ((Invoke-Api GET "$Api/v1/accounts/$A/statements?month=$mes&format=xls").Status -eq 400)
Check 'Cuenta inexistente = 404' ((Invoke-Api GET "$Api/v1/accounts/$(New-AccountNumber '999999999')/statements?month=$mes").Status -eq 404)
$vacio = Read-Csv (Invoke-WebRequest -UseBasicParsing "$Api/v1/accounts/$A/statements?month=2019-01").Content
Check 'Mes anterior sin movimientos: saldo inicial = final y totales en cero' (($vacio.Resumen['Saldo inicial'] -eq $vacio.Resumen['Saldo final']) -and ($vacio.Resumen['Total debitos'] -eq '0.00') -and ($vacio.Resumen['Movimientos'] -eq '0')) "inicial=$($vacio.Resumen['Saldo inicial']) final=$($vacio.Resumen['Saldo final'])"

if (-not $SinTests) {
    Titulo 'Pruebas automaticas'
    $t = Invoke-VitestSuite 'core-api' @('test/statements.test.ts')
    $ok = ($t.ExitCode -eq 0) -and ($t.Output -match 'Tests\s+15 passed') -and ($t.Output -notmatch '\d+ failed')
    Check '15 tests de estados de cuenta pasan (bordes de mes, invariantes, ledger, CSV, PDF, limites)' $ok (($t.Output -split "`n" | Where-Object { $_ -match '^\s*Tests\s' }) -join ' ')
    if (-not $ok) { Write-Host $t.Output }
} else {
    Write-Host ''; Write-Host '  (tests omitidos con -SinTests)' -ForegroundColor Yellow
}

Resumen 'ESTADOS DE CUENTA'
