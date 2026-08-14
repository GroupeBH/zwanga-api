# syntax=docker/dockerfile:1.7

# Node 20 is EOL in 2026. Node 22 matches package.json (engines.node >=22).
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-alpine AS base
WORKDIR /app

# dumb-init forwards Unix signals correctly when Node runs as PID 1.
# The AWS RDS global CA bundle is added to Node's trusted CAs so PostgreSQL
# TLS can keep certificate verification enabled in ECS production tasks.
RUN apk add --no-cache ca-certificates dumb-init wget \
    && wget -q -O /usr/local/share/ca-certificates/aws-rds-global-bundle.crt https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
    && update-ca-certificates

ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/aws-rds-global-bundle.crt

FROM base AS dependencies
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --legacy-peer-deps

FROM dependencies AS builder
COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM base AS production-dependencies
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --legacy-peer-deps

FROM base AS production
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node --from=production-dependencies /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist

RUN mkdir -p /app/uploads && chown -R node:node /app

USER node
EXPOSE 5200

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:5200/health >/dev/null || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
