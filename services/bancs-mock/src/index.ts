import { buildBancsMock } from './server';

const app = buildBancsMock();
const port = Number(process.env.PORT ?? 4000);

app
  .listen({ port, host: '0.0.0.0' })
  .then(() => app.log.info(`bancs-mock escuchando en :${port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

process.on('SIGTERM', () => void app.close().then(() => process.exit(0)));
process.on('SIGINT', () => void app.close().then(() => process.exit(0)));
