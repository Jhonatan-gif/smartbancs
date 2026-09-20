import { Pool, PoolClient } from 'pg';
import { config } from '../config';

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.dbPoolMax,
  min: config.dbPoolMin,
  // Si el pool está agotado, falla rápido (503) en vez de encolar sin límite.
  connectionTimeoutMillis: config.dbConnectTimeoutMs,
  statement_timeout: config.dbStatementTimeoutMs,
  // Una transacción no espera un bloqueo indefinidamente.
  options: `-c lock_timeout=${config.dbLockTimeoutMs}`,
});

// Una conexión inactiva puede morir (reinicio de PostgreSQL, corte de red). Sin este manejador
// el evento 'error' no capturado tumba el proceso; con él, el pool descarta el cliente y reconecta.
pool.on('error', (err) => {
  console.error(JSON.stringify({ level: 'error', service: 'core-api', msg: 'error en conexión inactiva del pool', err: err.message }));
});

/**
 * Ejecuta `fn` dentro de una transacción (READ COMMITTED + bloqueos de fila
 * explícitos). Hace COMMIT si termina bien y ROLLBACK ante cualquier error.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* la conexión pudo haberse caído; se ignora */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Abre `dbPoolMin` conexiones a la vez al arrancar, para que el primer pico no pague el coste de crearlas. */
export async function warmUpPool(): Promise<number> {
  const clients = await Promise.all(Array.from({ length: config.dbPoolMin }, () => pool.connect()));
  clients.forEach((c) => c.release());
  return clients.length;
}
