# syntax=docker/dockerfile:1

# ---- build: compile the RAG library and the MCP server ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/rag/package.json packages/rag/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/agent/package.json packages/agent/
RUN npm ci --ignore-scripts
COPY packages/rag packages/rag
COPY packages/mcp-server packages/mcp-server
RUN npx tsc -b packages/rag packages/mcp-server

# ---- runtime: production dependencies + compiled output only ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/rag/package.json packages/rag/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/agent/package.json packages/agent/
RUN npm ci --omit=dev --ignore-scripts --workspace @codebase-copilot/mcp-server \
  && npm cache clean --force
COPY --from=build /app/packages/rag/dist packages/rag/dist
COPY --from=build /app/packages/mcp-server/dist packages/mcp-server/dist

# Mount the repository to serve at /workspace (read-only is fine: the index is built in memory).
# stdout carries MCP protocol messages only, so run with -i and without a TTY.
USER node
WORKDIR /workspace
ENTRYPOINT ["node", "/app/packages/mcp-server/dist/cli.js", "--root", "/workspace"]
