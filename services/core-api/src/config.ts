const int = (value: string | undefined, fallback: number): number =>
  value !== undefined && value !== '' ? parseInt(value, 10) : fallback;

/**
 * Toda la configuración viene de variables de entorno (12-factor).
 * Los valores por defecto permiten desarrollar en local sin configurar nada.
 */
export const config = {
  port: int(process.env.PORT, 3000),
  logLevel: process.env.LOG_LEVEL ?? 'info',

  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://smartbancs:smartbancs@localhost:5432/smartbancs',
  dbPoolMax: int(process.env.DB_POOL_MAX, 20),
  // Conexiones que se abren al arrancar y NO se cierran por inactividad: evita crear conexiones nuevas en plena carga.
  dbPoolMin: Math.min(int(process.env.DB_POOL_MIN, 10), int(process.env.DB_POOL_MAX, 20)),
  dbConnectTimeoutMs: int(process.env.DB_CONNECT_TIMEOUT_MS, 2000),
  // Si un bloqueo tarda más que esto, falla rápido en vez de acumular esperas.
  dbLockTimeoutMs: int(process.env.DB_LOCK_TIMEOUT_MS, 1500),
  // Un paso SQL que tarde más de esto se registra como lento (con su nombre y trace_id).
  slowOpMs: int(process.env.SLOW_OP_MS, 200),
  dbStatementTimeoutMs: int(process.env.DB_STATEMENT_TIMEOUT_MS, 3000),

  // "on"  -> bloquea las cuentas siempre en orden de id (sin deadlocks).
  // "off" -> bloquea en el orden de la petición: sirve SOLO para reproducir
  //          el incidente de deadlocks en la demo (sección 3.5 del reto).
  lockOrdering: (process.env.LOCK_ORDERING ?? 'on') !== 'off',
  // Pausa artificial entre el primer y el segundo bloqueo (solo con LOCK_ORDERING=off).
  simulatedLockDelayMs: int(process.env.SIMULATED_LOCK_DELAY_MS, 0),

  // Máximo de movimientos en un estado de cuenta (si se supera: 422 STATEMENT_TOO_LARGE).
  statementMaxRows: int(process.env.STATEMENT_MAX_ROWS, 20_000),

  // ai-service (recomendaciones). NO participa en las transferencias: solo lo usa el endpoint de recomendaciones.
  aiServiceUrl: process.env.AI_SERVICE_URL ?? 'http://localhost:8000',
  aiTimeoutMs: int(process.env.AI_TIMEOUT_MS, 300),
  aiBreakerThreshold: int(process.env.AI_BREAKER_THRESHOLD, 3),
  aiBreakerCooldownMs: int(process.env.AI_BREAKER_COOLDOWN_MS, 10_000),
};
