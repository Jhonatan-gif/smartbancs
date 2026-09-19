export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/**
 * Traduce errores de PostgreSQL / del pool a respuestas HTTP claras.
 * Códigos SQLSTATE: https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
export function mapDbError(err: unknown): AppError | null {
  const e = err as { code?: string; message?: string };
  switch (e?.code) {
    case '40P01':
      return new AppError(409, 'DEADLOCK_DETECTED', 'Conflicto de concurrencia, reintente la operación');
    case '40001':
      return new AppError(409, 'SERIALIZATION_FAILURE', 'Conflicto de concurrencia, reintente la operación');
    case '55P03':
      return new AppError(503, 'LOCK_TIMEOUT', 'El recurso está ocupado, reintente en unos segundos');
    case '57014':
      return new AppError(503, 'DB_TIMEOUT', 'La base de datos tardó demasiado en responder');
    case '53300':
      return new AppError(503, 'DB_TOO_MANY_CONNECTIONS', 'Base de datos saturada');
  }
  if (typeof e?.message === 'string' && e.message.includes('timeout exceeded when trying to connect')) {
    return new AppError(503, 'POOL_TIMEOUT', 'Servicio saturado, reintente en unos segundos');
  }
  return null;
}
