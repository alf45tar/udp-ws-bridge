// -------------------------
// WS-UDP Bridge (Bun)
// -------------------------
import dgram from "node:dgram";
import os from "node:os";
import mdns from "multicast-dns";

const VERSION = "0.3.0";
const WS_PORT = 8081;
const UDP_PORT = 6454; // Art-Net standard

console.log(`[Bridge] UDP ↔ WebSocket Bridge v${VERSION}`);

// -------------------------
// UDP Socket
// -------------------------
const udpSocket = dgram.createSocket({ type: "udp4", reuseAddr: true });

// Ensure UDP socket is ready before sending
const udpReady = new Promise<void>((resolve, reject) => {
  udpSocket.once("listening", () => {
    console.log(`[Bridge] UDP socket listening on port ${UDP_PORT}`);
    udpSocket.setBroadcast(true);
    resolve();
  });

  udpSocket.once("error", (err) => {
    console.error("[Bridge] UDP socket error:", err);
    reject(err);
  });
});

// Track sent messages to filter echoes
const sentMessages = new Map<string, number>();
const NO_ECHO_TIMEOUT = 100; // milliseconds

// Cleanup old entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of sentMessages.entries()) {
    if (now - timestamp > NO_ECHO_TIMEOUT) {
      sentMessages.delete(key);
    }
  }
}, 50);

udpSocket.bind(UDP_PORT);

// Optional UDP debug logging
udpSocket.on("message", (_msg, _rinfo) => {
  // Just log, don't filter here - let per-client handlers filter
  // console.log(`[Bridge] UDP received ${_msg.length} bytes from ${_rinfo.address}:${_rinfo.port}`);
});

// -------------------------
// mDNS Hostname Resolution
// -------------------------
const mdnsServer = mdns();
const hostname = "udp-ws-bridge.local";
let mdnsRegistered = false;

// Get local IP addresses
function getLocalIPs() {
  const ips: string[] = [];
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.family === "IPv4" && !addr.internal) {
        ips.push(addr.address);
      }
    }
  }
  return ips;
}

// Respond to mDNS queries for our hostname
mdnsServer.on("query", (query) => {
  const answers: any[] = [];

  for (const question of query.questions) {
    if (question.name === hostname && question.type === "A") {
      const ips = getLocalIPs();
      for (const ip of ips) {
        answers.push({
          name: hostname,
          type: "A",
          ttl: 120,
          data: ip,
        });
        // Mark mDNS as registered once we respond to the first query
        mdnsRegistered = true;
      }
    }
  }

  if (answers.length > 0) {
    mdnsServer.respond(answers);
  }
});

console.log(`[Bridge] mDNS hostname published: ${hostname}`);

// -------------------------
// WebSocket Server (Bun)
// -------------------------
console.log(`[Bridge] WebSocket bridge running on ws://${hostname}:${WS_PORT}`);

Bun.serve({
  port: WS_PORT,

  fetch(req, server) {
    const url = new URL(req.url);
    const host = req.headers.get("host") || url.host;

    if (server.upgrade(req, { data: { host } })) {
      return;
    }
    return new Response("WebSocket only", { status: 400 });
  },

  websocket: {
    open(ws) {
      const connectedHost = ws.data?.host || `${hostname}:${WS_PORT}`;
      console.log(`[Bridge] Browser connected from ${ws.remoteAddress} to ${connectedHost}`);

      // UDP → Browser
      const udpHandler = (msg: Buffer, rinfo: dgram.RemoteInfo) => {
        // Check if this is an echo message we should filter
        // Only check the data, not the source address/port (which changes on echo)
        const msgKey = JSON.stringify({
          data: [...msg],
        });

        if (sentMessages.has(msgKey)) {
          // Don't delete here - let the cleanup timer handle it
          // This ensures all handlers (if multiple connections) can see the filter
          return; // Skip this echo
        }

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "udp-message",
              address: rinfo.address,
              port: rinfo.port,
              data: [...msg], // byte array
            })
          );
        }
      };

      udpSocket.on("message", udpHandler);

      // Store handler for cleanup
      ws.data = { udpHandler };
    },

    async message(ws, raw) {
      await udpReady;

      try {
        const msg = JSON.parse(raw.toString());

        // Browser → UDP
        if (msg.type === "udp-send") {
          const buf = Buffer.from(msg.data);
          udpSocket.send(buf, msg.port, msg.address, (err) => {
            if (err) console.error("[Bridge] UDP send error:", err);
          });
        }

        // Browser → UDP (no echo)
        if (msg.type === "udp-send-no-echo") {
          const buf = Buffer.from(msg.data);
          // Only use data for filtering, not address/port (which changes on echo)
          const msgKey = JSON.stringify({
            data: [...buf],
          });
          // Register the message BEFORE sending to catch any echoes
          sentMessages.set(msgKey, Date.now());

          udpSocket.send(buf, msg.port, msg.address, (err) => {
            if (err) console.error("[Bridge] UDP send error:", err);
          });
        }
      } catch (err) {
        console.error("[Bridge] Invalid WS message:", err);
      }
    },

    close(ws) {
      console.log("[Bridge] Browser disconnected");

      if (ws.data?.udpHandler) {
        udpSocket.off("message", ws.data.udpHandler);
      }
    },
  },
});