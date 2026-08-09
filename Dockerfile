# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: Dependencies
# Install all dependencies (including devDependencies for build)
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Install build tools for native modules
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package.json package-lock.json ./

# Install all dependencies (including dev for build)
RUN npm ci --frozen-lockfile

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: Builder
# Compile TypeScript to JavaScript
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Prune devDependencies for production
RUN npm prune --production

# ─────────────────────────────────────────────────────────────────────────────
# Stage 3: Production Runner
# Minimal production image with non-root user
# Target: < 150MB image size
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS production

# Security: Set non-root user
ARG UID=1001
ARG GID=1001

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create app directory with correct ownership
WORKDIR /app

# Create non-root user
RUN addgroup -g ${GID} -S appgroup && \
    adduser -u ${UID} -S appuser -G appgroup

# Copy production artifacts from builder
COPY --from=builder --chown=appuser:appgroup /app/dist ./dist
COPY --from=builder --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:appgroup /app/package.json ./package.json

# Create logs directory
RUN mkdir -p logs && chown appuser:appgroup logs

# Security hardening
RUN chmod -R 550 /app/dist && \
    chmod -R 550 /app/node_modules && \
    chmod 770 /app/logs

# Switch to non-root user
USER appuser

# Expose application port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health/live || exit 1

# Use dumb-init to handle PID 1 and signal forwarding
ENTRYPOINT ["dumb-init", "--"]

# Run pending migrations, then start the app. Schema is owned by
# src/database/migrations/ (synchronize is always false — see
# app.module.ts) — this is the actual "deploy step that runs migrations
# before the new app version starts serving traffic."
CMD ["sh", "-c", "node ./node_modules/typeorm/cli.js -d dist/database/data-source.js migration:run && exec node dist/main.js"]
