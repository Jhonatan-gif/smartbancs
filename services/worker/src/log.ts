/** Logs estructurados en JSON (una línea por evento), listos para Loki / Dynatrace. */
export function log(level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown> = {}) {
  if (process.env.LOG_LEVEL === 'silent') return;
  console.log(JSON.stringify({ level, time: new Date().toISOString(), service: 'worker', msg, ...fields }));
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
