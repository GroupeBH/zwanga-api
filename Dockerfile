ARG NODE_BASE_IMAGE=node:20-bookworm-slim
FROM ${NODE_BASE_IMAGE} AS base
WORKDIR /app

# Required for proper PID 1 signal handling in containers.
RUN apt-get update \
  && apt-get install -y --no-install-recommends dumb-init \
  && rm -rf /var/lib/apt/lists/*

FROM base AS deps
COPY package*.json ./
RUN \
  npm config set fetch-retries 5 \
  && npm config set fetch-retry-mintimeout 20000 \
  && npm config set fetch-retry-maxtimeout 120000 \
  && npm config set fetch-timeout 300000 \
  && sh -c 'for i in 1 2 3; do npm ci --legacy-peer-deps && exit 0; echo "npm ci failed (attempt $i/3), retrying..."; sleep $((i * 10)); done; exit 1'

FROM deps AS builder
COPY . .
RUN npm run build

FROM base AS production-deps
COPY package*.json ./
RUN \
  npm config set fetch-retries 5 \
  && npm config set fetch-retry-mintimeout 20000 \
  && npm config set fetch-retry-maxtimeout 120000 \
  && npm config set fetch-timeout 300000 \
  && sh -c 'for i in 1 2 3; do npm ci --omit=dev --legacy-peer-deps && exit 0; echo "npm ci --omit=dev failed (attempt $i/3), retrying..."; sleep $((i * 10)); done; exit 1'

FROM deps AS development
ENV NODE_ENV=development
COPY . .
EXPOSE 5200
CMD ["npm", "run", "start:dev"]

FROM base AS production
ENV NODE_ENV=production
COPY package*.json ./
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
RUN mkdir -p /app/uploads && chown -R node:node /app
USER node
EXPOSE 5200
CMD ["dumb-init", "node", "dist/main.js"]
