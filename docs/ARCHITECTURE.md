# Architecture Overview

This template shows a minimal, public-safe layout for a realtime dashboard consuming Emotiv Cortex API.

## Components

- `server/` (Node.js):
  - Connects to Cortex API via WebSocket (JSON-RPC).
  - Bridges data to client(s) via web socket endpoint.
  - Serves static files from `web/`.

- `web/`:
  - Minimal HTML/JS placeholder.
  - Connects to server's websocket and renders basic status.

## Data Flow (intended)

`Cortex (wss://localhost:6868)` → `server/src/cortexClient` → `server WebSocket /ws` → `web/app.js`

## Security Considerations

- No secrets or raw data committed; environment variables only.
- Default `AUTO_CONNECT=false` to avoid accidental connections.
- TLS note: Cortex uses a self-signed certificate. Use `NODE_TLS_REJECT_UNAUTHORIZED=0` ONLY for local dev.

## Next Steps

- Implement JSON-RPC calls: `authorize`, `createSession`, `subscribe`.
- Add robust reconnection/backoff and error handling.
- Integrate visualization (charts) on the client side.
