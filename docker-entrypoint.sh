#!/bin/sh
# Selects the MCP transport at container launch.
#   OMNI_TRANSPORT=stdio  (default) -> src/server.js, for Claude Desktop etc.
#   OMNI_TRANSPORT=http             -> src/http.js, Streamable HTTP / SSE endpoint.
# Any other value is rejected loudly rather than silently defaulting.
set -e

case "${OMNI_TRANSPORT:-stdio}" in
  stdio)
    exec node --no-warnings src/server.js
    ;;
  http|sse)
    exec node --no-warnings src/http.js
    ;;
  *)
    echo "[ridgeline] Unknown OMNI_TRANSPORT='${OMNI_TRANSPORT}'. Use 'stdio' or 'http'." >&2
    exit 1
    ;;
esac
