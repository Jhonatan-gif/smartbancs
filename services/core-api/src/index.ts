import { config } from './config';
import { pool } from './infra/db';
import { buildApp } from './server';

const app = buildApp();

async function shutdown(signal: string) {
  app.log.info({ signal }, 'apagando servicio');
  await app.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

app
  .listen({ port: config.port, host: '0.0.0.0' })
  .then(() => app.log.info(`core-api escuchando en :${config.port} (lockOrdering=${config.lockOrdering})`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
