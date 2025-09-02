const path = require("path");
const http = require("http");
const os = require("os");
const WebSocket = require("ws");

const config = require("./config");
const CortexClient = require("./cortexClient");
const { createApp } = require("./app");
const { isTokenValid } = require("./utils/auth");
const streamRefs = require("./utils/streamManager");
const cortex = new CortexClient(config.cortex);
const app = createApp(cortex);
const server = http.createServer(app);

// WebSocket for browser clients
const wss = new WebSocket.Server({ server, path: "/ws" });

function broadcast(obj) {
  const data = JSON.stringify(obj);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  });
}

// Expose broadcast to Express app so routes can push custom events (e.g., EOG)
app.locals.broadcast = broadcast;

// Cortex event wiring
cortex.on("log", (m) => console.log("[cortex]", m));
cortex.on("error", (e) => console.error("[cortex:error]", e.message || e));
cortex.on("eeg", (payload) => broadcast({ type: "eeg", payload }));
cortex.on("pow", (payload) => broadcast({ type: "pow", payload }));
// Stream motion
cortex.on("mot", (payload) => broadcast({ type: "mot", payload }));
// Stream device information
cortex.on("dev", (payload) => broadcast({ type: "dev", payload }));
// Stream EEG quality
cortex.on("eq", (payload) => broadcast({ type: "eq", payload }));
// Stream performance metrics
cortex.on("met", (payload) => broadcast({ type: "met", payload }));
// Stream mental command
cortex.on("com", (payload) => broadcast({ type: "com", payload }));
// Stream facial expression
cortex.on("fac", (payload) => broadcast({ type: "fac", payload }));
// Also broadcast labels for subscribed streams so the UI can render nicely
cortex.on("new_data_labels", (payload) => broadcast({ type: "labels", payload }));

// Client connections (optional token check via ?token=)
wss.on("connection", (ws, req) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const provided = url.searchParams.get("token");
    if (!isTokenValid(provided)) {
      ws.close(1008, "Unauthorized");
      return;
    }
  } catch (_) {
    if (!isTokenValid(undefined)) {
      try { ws.close(1008, "Unauthorized"); } catch (_) {}
      return;
    }
  }
  ws.send(
    JSON.stringify({ type: "hello", message: "Connected to dashboard stream" })
  );
});

async function start() {
  server.listen(config.port, config.host, () => {
    const nets = os.networkInterfaces();
    const addrs = [];
    for (const name of Object.keys(nets)) {
      for (const n of nets[name] || []) {
        if (n.family === "IPv4" && !n.internal) addrs.push(n.address);
      }
    }
    console.log(`Server listening on:`);
    console.log(`  - http://localhost:${config.port}`);
    if (config.host !== "localhost") {
      for (const ip of addrs) console.log(`  - http://${ip}:${config.port}`);
    }
  });

  if (!config.autoConnect) {
    console.log("AUTO_CONNECT=false. Skipping Cortex connection.");
    return;
  }

  try {
    // Use official-like flow to get ready
    await cortex.prepare();
    await cortex.subscribe(["pow"]);
  } catch (err) {
    console.error("Failed to initialize Cortex flow:", err.message || err);
  }
  // Optional: mark AUTO_CONNECT as a holder so accidental stop doesn't unsubscribe
  try { streamRefs.start('pow', 'AUTO_CONNECT'); } catch (_) {}
}

start();

// Periodically prune expired holders; unsubscribe if stream becomes empty
setInterval(async () => {
  try {
    const empties = streamRefs.prune();
    for (const s of empties) {
      if (s === 'pow') {
        try { await cortex.unsubscribe([s]); } catch (_) {}
      }
    }
  } catch (_) {}
}, 30_000);
