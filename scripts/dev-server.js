// Dev server: watches build output and notifies extension to reload
const { WebSocketServer } = require("ws");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const BUILD_DIR = path.join(__dirname, "..", "build", "chrome");
const RELOAD_PORT = 9876;

// Track build file timestamps
let lastMtime = 0;

function getLatestMtime(dir) {
  let latest = 0;
  if (!fs.existsSync(dir)) return 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else latest = Math.max(latest, fs.statSync(full).mtimeMs);
    }
  };
  walk(dir);
  return latest;
}

// Start WebSocket server
const wss = new WebSocketServer({ port: RELOAD_PORT });
console.log(`🔌 Reload server on ws://localhost:${RELOAD_PORT}`);

wss.on("connection", (ws) => {
  console.log("Extension connected");
  ws.on("close", () => console.log("Extension disconnected"));
});

// Broadcast reload to all connected clients
function broadcastReload() {
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send("reload");
    }
  });
}

// Manual reload via HTTP for manual trigger
require("http")
  .createServer((req, res) => {
    if (req.url === "/reload" || req.url === "/ping") {
      broadcastReload();
      res.writeHead(200, {
        "Content-Type": "text/plain",
        "Access-Control-Allow-Origin": "*",
      });
      res.end("ok");
    } else {
      res.writeHead(404);
      res.end();
    }
  })
  .listen(RELOAD_PORT + 1);

// Watch build directory for changes
console.log("👀 Watching build output for changes...");
setInterval(() => {
  const mtime = getLatestMtime(BUILD_DIR);
  if (mtime > lastMtime && lastMtime > 0) {
    console.log("🔄 Build changed! Reloading extension...");
    broadcastReload();
  }
  lastMtime = mtime;
}, 1000);
