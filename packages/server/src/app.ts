import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerRoutes } from './routes/api.js';
import { runtime } from './game/runtime.js';
import { redactTokenQuery } from './game/sessions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function buildApp() {
  const app = Fastify({
    logger: {
      serializers: {
        req(request) {
          return {
            method: request.method,
            url: redactTokenQuery(request.url),
            hostname: request.hostname,
            remoteAddress: request.ip,
            remotePort: request.socket?.remotePort,
          };
        },
      },
    },
  });

  // `WAR_PATROL_CORS_ORIGIN`: comma-separated allowlist for public/internet deploys
  // (e.g. `https://stations.example.com`). Unset (default) reflects any Origin —
  // fine for the LAN-party flow where the client is served same-origin or from a
  // trusted local Vite dev server; tighten this when exposing the API cross-origin
  // to untrusted networks (see docs/internet-hosting.md).
  const corsOriginEnv = process.env.WAR_PATROL_CORS_ORIGIN?.trim();
  const corsOrigin =
    corsOriginEnv && corsOriginEnv !== '*'
      ? corsOriginEnv.split(',').map((o) => o.trim()).filter(Boolean)
      : true;
  await app.register(cors, {
    origin: corsOrigin,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });

  await registerRoutes(app);

  // Serve Vite client build when present (production / docker).
  const clientDistCandidates = [
    path.resolve(__dirname, '../../client/dist'),
    path.resolve(__dirname, '../client/dist'),
  ];
  const clientDist = clientDistCandidates.find((p) => existsSync(p));
  if (clientDist) {
    await app.register(fastifyStatic, {
      root: clientDist,
      prefix: '/',
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  runtime.sse.startHeartbeat();
  return app;
}
