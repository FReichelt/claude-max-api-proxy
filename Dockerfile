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

# Run as the non-root `node` user (uid 1000, present in the node base image).
# The Claude CLI refuses --dangerously-skip-permissions under root/sudo, which the
# proxy always passes, so running as root makes every completion fail. Give the
# node user a writable, node-owned HOME and pre-create ~/.claude so a mounted
# named volume inherits node ownership (Docker seeds an empty volume from the
# image dir). Auth once inside the container with `claude setup-token`; the token
# persists in that volume across restarts — no host credential mount required.
RUN mkdir -p /home/node/.claude && chown -R node:node /home/node
ENV HOME=/home/node
USER node

ENTRYPOINT ["node", "dist/server/standalone.js"]
CMD []
