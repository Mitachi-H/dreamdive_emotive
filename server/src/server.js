const path = require("path");
const http = require("http");
const os = require("os");
const WebSocket = require("ws");

const config = require("./config");
const CortexClient = require("./cortexClient");
const { createApp } = require("./app");
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

// Cortex event wiring
cortex.on("log", (m) => console.log("[cortex]", m));
cortex.on("error", (e) => console.error("[cortex:error]", e.message || e));
cortex.on("eeg", (payload) => broadcast({ type: "eeg", payload }));

// Client connections
wss.on("connection", (ws) => {
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
    // Connect and subscribe (adjust streams as needed)
    await cortex.connect();
    await cortex.authorize();
    await cortex.createSession("open");
    await cortex.subscribe(["eeg"]);
  } catch (err) {
    console.error("Failed to initialize Cortex flow:", err.message || err);
  }
}

start();
