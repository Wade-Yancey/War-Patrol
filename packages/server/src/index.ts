import { buildApp } from './app.js';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '0.0.0.0';

const app = await buildApp();
await app.listen({ port, host });
console.log(`War Patrol server listening on http://${host}:${port}`);
