# syntax=docker/dockerfile:1.7

# Node 20 is EOL in 2026. Node 22 matches package.json (engines.node >=22).
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-alpine AS base
WORKDIR /app

# dumb-init forwards Unix signals correctly when Node runs as PID 1.
RUN apk add --no-cache dumb-init

FROM base AS dependencies
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --legacy-peer-deps

FROM dependencies AS builder
COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM base AS production-dependencies
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --legacy-peer-deps \
    && npm cache clean --force

FROM base AS production
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node --from=production-dependencies /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist

RUN mkdir -p /app/uploads && chown -R node:node /app

USER node
EXPOSE 5200

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:5200/api/v1/health >/dev/null || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
