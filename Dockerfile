# syntax=docker/dockerfile:1

# ---- deps: install once, cached separately from source so an ordinary code
# change doesn't force a full npm install again ----
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime ----
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

# Debian-based "slim" image, not alpine — bcrypt is a native module, and
# alpine's musl libc has a real history of native-module build/runtime
# friction that debian-slim avoids. Worth the extra ~40MB.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# Runs as a non-root user — a container breakout or a dependency RCE then
# doesn't hand over root inside the container for free.
RUN groupadd --system app && useradd --system --gid app app \
  && chown -R app:app /app
USER app

EXPOSE 5000

# Matches GET /api/health — same endpoint your uptime monitor already hits,
# now also used by Docker/PM2/whatever orchestrates this container to know
# when it's actually ready, not just "the process started."
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:5000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
