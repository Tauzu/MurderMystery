import { buildApp } from './app';

const port = Number(process.env.PORT ?? 3001);
const app = buildApp();

app.listen({ port, host: '0.0.0.0' }).then(() => {
  console.log(`server listening on :${port}`);
});
