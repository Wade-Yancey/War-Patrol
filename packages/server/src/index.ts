import { buildApp } from './app.js';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '0.0.0.0';

// Live tabletop events: a single stray unhandled rejection / synchronous
// throw outside a request context (e.g. an SSE socket event listener)
// should not take down an in-progress game for every connected station.
// Log loudly and keep serving; fix root causes as they surface here.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

const app = await buildApp();
await app.listen({ port, host });
console.log(`War Patrol server listening on http://${host}:${port}`);
