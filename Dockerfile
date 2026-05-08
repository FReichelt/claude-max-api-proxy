# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:20-slim

WORKDIR /app

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Copy production deps and compiled output
COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

EXPOSE 3456

ENV PORT=3456

ENTRYPOINT ["node", "dist/server/standalone.js"]
CMD []
