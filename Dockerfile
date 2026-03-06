# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS base
WORKDIR /app

# Required for proper PID 1 signal handling in containers.
RUN apt-get update \
  && apt-get install -y --no-install-recommends dumb-init \
  && rm -rf /var/lib/apt/lists/*

FROM base AS deps
COPY package*.json ./
RUN npm ci --legacy-peer-deps

FROM deps AS builder
COPY . .
RUN npm run build

FROM base AS production-deps
COPY package*.json ./
RUN npm ci --omit=dev --legacy-peer-deps

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
