# Ridgeline T1D MCP server.
# Runs as either a stdio MCP server (default, launched by the client as a
# subprocess) or a Streamable HTTP / SSE server (OMNI_TRANSPORT=http).

FROM node:22-slim

WORKDIR /app

# Dependencies first for layer caching.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# The SQLite archive lives here. Mount a host folder onto /data so the archive
# survives container rebuilds (see README). OMNI_DB_PATH points at it.
ENV OMNI_DB_PATH=/data/omni-endo.db
VOLUME ["/data"]

# Transport selection (see docker-entrypoint.sh):
#   OMNI_TRANSPORT=stdio (default) | http
# HTTP mode listens on OMNI_HTTP_PORT (default 3000). Expose it for that mode;
# it is ignored under stdio. Bind/host/token are set via env at runtime.
ENV OMNI_TRANSPORT=stdio
EXPOSE 3000

# Credentials are supplied at runtime via --env-file (GLOOKO_EMAIL/PASSWORD).
# Nothing sensitive is baked into the image.

# node:sqlite is built into Node 22 but flagged experimental; --no-warnings in
# the entrypoint keeps its notice out of stderr. stdout stays the MCP channel
# under stdio.
ENTRYPOINT ["./docker-entrypoint.sh"]
