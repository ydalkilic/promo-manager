# syntax=docker/dockerfile:1

# --- build stage ------------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies, then regenerate the Prisma client because `npm prune`
# removes the generated artefacts under node_modules/.prisma along the way.
#
# `prisma` is a runtime dependency rather than a dev one specifically so this
# works offline and deterministically: the compose `migrate` service runs
# `prisma migrate deploy` from this image, so the CLI has to survive the prune.
# It previously survived only because `npx` silently re-fetched it, which would
# break in an air-gapped build.
RUN npm prune --omit=dev && npx prisma generate

# --- runtime stage ----------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends openssl curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json ./

# Run unprivileged. The storage mount is the only path needing write access.
RUN mkdir -p /app/storage && chown -R node:node /app/storage
USER node

EXPOSE 3000

# No image-level HEALTHCHECK on purpose. This one image runs both the API and
# the ingestion worker, and the worker serves no HTTP. An inherited
# `curl localhost:3000/health` marked the worker permanently unhealthy even
# while it was correctly draining the queue — which in an orchestrator reads as
# a failing task and triggers restart loops. Each service declares the probe
# that actually describes it; see docker-compose.yml.

CMD ["node", "dist/server.js"]
