FROM node:22-bookworm
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol ./packages/protocol
COPY apps/agent ./apps/agent
COPY apps/node-agent ./apps/node-agent
COPY apps/pi-runtime ./apps/pi-runtime
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @pi-ops/protocol build \
  && pnpm --filter @pi-ops/agent build \
  && pnpm --filter @pi-ops/node-agent build \
  && pnpm --filter @pi-ops/pi-runtime build
# Provider catalog for the Pi SDK (baseUrl only; the API key arrives via env).
COPY deploy/docker/models.json /root/.pi/agent/models.json
ENV NODE_ENV=production
CMD ["node", "apps/agent/dist/index.js"]
