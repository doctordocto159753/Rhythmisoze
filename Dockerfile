# The Rhythmisoze web application.
#
# Three stages so the runtime image carries neither the build toolchain nor the
# dev dependency tree. The final image is the Next standalone bundle plus the
# static assets, which is a few hundred megabytes rather than a couple of
# gigabytes -- and a smaller image is a faster redeploy on a single small VPS,
# which is the deployment this edition targets.

# --- dependencies -------------------------------------------------------
FROM node:20-bookworm-slim AS deps
WORKDIR /app
# Only the manifests, so a source edit does not invalidate the install layer.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# --- build --------------------------------------------------------------
FROM node:20-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# The site URL is baked into client bundles at build time, so it has to be a
# build argument rather than only a runtime variable.
ARG NEXT_PUBLIC_SITE_URL=http://localhost:3000
ENV NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL}
RUN npm run build

# --- runtime ------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs nextjs

COPY --from=build /app/public ./public
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static

# Published objects live on a mounted volume. Created here so the directory
# exists and is writable before any volume is mounted over it.
RUN mkdir -p /data/objects && chown -R nextjs:nodejs /data

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:3000/api/musician/status',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
