FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN pnpm install --frozen-lockfile=false
COPY packages packages
RUN pnpm --filter @war-patrol/shared build \
 && pnpm --filter @war-patrol/client build \
 && pnpm --filter @war-patrol/server build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY --from=build /app /app
EXPOSE 8787
CMD ["pnpm", "--filter", "@war-patrol/server", "start"]
