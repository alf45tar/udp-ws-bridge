// -------------------------
// WS-UDP Bridge (Bun)
// -------------------------
import dgram from "node:dgram";
import os from "node:os";
import mdns from "multicast-dns";

const VERSION = "0.4.0";
const WS_PORT = 8081;
const UDP_PORT = 6454; // Art-Net standard
const BINARY_PROTOCOL_VERSION = 1;

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
const sentMessages = new Map<number, number>();
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

type ClientMode = "json" | "binary";

interface WSMetadata {
  host: string;
  mode: ClientMode;
}

const clients = new Set<WebSocket>();

// Cheap hash for echo-filtering to avoid repeated JSON/string allocations
const hashBuffer = (buf: Uint8Array | Buffer) => Bun.hash(buf);

const ipToBytes = (ip: string) => ip.split(".").map((octet) => Number(octet) & 0xff);

const bytesToIp = (bytes: Uint8Array, offset: number) =>
  `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`;

const buildBinaryFrame = (rinfo: dgram.RemoteInfo, msg: Buffer) => {
  // Layout: [ver][type][port hi][port lo][a][b][c][d][len hi][len lo][payload...]
  const header = new Uint8Array(10);
  header[0] = BINARY_PROTOCOL_VERSION;
  header[1] = 0x01; // udp-message
  header[2] = (rinfo.port >> 8) & 0xff;
  header[3] = rinfo.port & 0xff;
  const ipParts = ipToBytes(rinfo.address);
  header.set(ipParts, 4);
  header[8] = (msg.length >> 8) & 0xff;
  header[9] = msg.length & 0xff;

  const frame = new Uint8Array(header.length + msg.length);
  frame.set(header, 0);
  frame.set(msg, header.length);
  return frame;
};

Bun.serve({
  port: WS_PORT,

  fetch(req, server) {
    const hostHeader = req.headers.get("host") || "localhost";
    const protocols = (req.headers.get("sec-websocket-protocol") || "")
      .split(",")
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean);

    // Fast path: check protocol first, then cheap string check for query param
    const wantsBinary =
      protocols.includes("binary") || req.url.includes("mode=binary");
    const mode: ClientMode = wantsBinary ? "binary" : "json";

    if (server.upgrade(req, { data: { host: hostHeader, mode } satisfies WSMetadata })) {
      return;
    }
    return new Response("WebSocket only", { status: 400 });
  },

  websocket: {
    open(ws) {
      const meta = ws.data as WSMetadata;
      const connectedHost = meta?.host || `${hostname}:${WS_PORT}`;
      console.log(
        `[Bridge] Browser connected from ${ws.remoteAddress} to ${connectedHost} (${meta.mode} mode)`
      );

      clients.add(ws);
    },

    async message(ws, raw) {
      await udpReady;

      const meta = ws.data as WSMetadata;

      // Binary fast-path
      if (meta.mode === "binary" && raw instanceof Uint8Array) {
        const view = raw;
        if (view.length < 10 || view[0] !== BINARY_PROTOCOL_VERSION) {
          console.error("[Bridge] Invalid binary frame");
          return;
        }

        const type = view[1];
        const port = (view[2] << 8) | view[3];
        const addr = bytesToIp(view, 4);
        const len = (view[8] << 8) | view[9];
        if (len !== view.length - 10) {
          console.error("[Bridge] Binary length mismatch");
          return;
        }

        const payload = view.subarray(10);

        if (type === 0x02 || type === 0x03) {
          const hash = type === 0x03 ? hashBuffer(payload) : null;
          if (hash !== null) {
            sentMessages.set(hash, Date.now());
          }

          udpSocket.send(Buffer.from(payload), port, addr, (err) => {
            if (err) console.error("[Bridge] UDP send error:", err);
          });
        }
        return;
      }

      // JSON path
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === "udp-send" || msg.type === "udp-send-no-echo") {
          const buf = Buffer.from(msg.data);
          const hash = msg.type === "udp-send-no-echo" ? hashBuffer(buf) : null;
          if (hash !== null) {
            sentMessages.set(hash, Date.now());
          }

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
      clients.delete(ws);
    },
  },
});

// UDP → WebSocket broadcast (single handler to avoid per-connection overhead)
udpSocket.on("message", (msg: Buffer, rinfo: dgram.RemoteInfo) => {
  const hash = hashBuffer(msg);
  if (sentMessages.has(hash)) {
    return; // filtered echo
  }

  let jsonPayload: string | null = null;
  let binaryPayload: Uint8Array | null = null;

  for (const client of clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    const meta = client.data as WSMetadata;

    if (meta.mode === "binary") {
      if (!binaryPayload) binaryPayload = buildBinaryFrame(rinfo, msg);
      client.send(binaryPayload);
    } else {
      if (!jsonPayload) {
        jsonPayload = JSON.stringify({
          type: "udp-message",
          address: rinfo.address,
          port: rinfo.port,
          data: [...msg],
        });
      }
      client.send(jsonPayload);
    }
  }
});