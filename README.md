# UDP ↔ WebSocket Bridge for Art-Net

[![Latest release](https://img.shields.io/github/v/release/alf45tar/udp-ws-bridge?include_prereleases&sort=semver&logo=github)](https://github.com/alf45tar/udp-ws-bridge/releases/latest)

A minimal bridge that relays UDP packets (Art-Net by default) to browser WebSocket clients and back. Useful for piping lighting/control data into web UIs.

## Why a bridge?
- Browsers cannot open UDP sockets: they speak HTTP(S) and WebSocket; raw UDP (and especially broadcast) is blocked by the web sandbox for security.
- Art-Net runs over UDP (port 6454), commonly using broadcast on the local network, which a web app in a browser cannot access directly.
- This bridge terminates a browser WebSocket and reads/writes UDP on your LAN, translating JSON messages ↔ raw UDP bytes.
```
Browser (WebSocket) ⇄ Bridge (WS ⇄ UDP) ⇄ Art-Net device (UDP 6454)
```

## Get started
- Download a prebuilt executable (no Bun required) using direct links below.
- Or run from source (requires Bun): see Run locally (dev) below.

## Download executables
Direct links to latest release (per platform):
- [Linux (x64)](https://github.com/alf45tar/udp-ws-bridge/releases/latest/download/udp-ws-bridge-linux-x64.zip)
- [Windows (x64)](https://github.com/alf45tar/udp-ws-bridge/releases/latest/download/udp-ws-bridge-windows-x64.zip)
- [macOS (x64)](https://github.com/alf45tar/udp-ws-bridge/releases/latest/download/udp-ws-bridge-darwin-x64.zip)
- [macOS (arm64)](https://github.com/alf45tar/udp-ws-bridge/releases/latest/download/udp-ws-bridge-darwin-arm64.zip)

Or visit the Releases page for all assets.

### macOS: clear quarantine (Gatekeeper)
If macOS reports the app or binary as "is damaged" after download, clear the quarantine attribute:

```bash
xattr -dr com.apple.quarantine udp-ws-bridge-<version>
```

Then run the binary normally.

### macOS: Run bridge in background
**Tip for macOS users**: You can use **Shortcuts** or **Automator** to create a quick launcher app for the bridge.

*Detailed setup instructions are out of scope here, but easily available by searching online or asking an AI assistant.*

## Requirements
- Bun (https://bun.sh) — required only if you run from source or build manually. Prebuilt executables do not require Bun.

## Run locally (dev)
```bash
bun run main.ts
```
Then connect your browser/WebSocket client to `ws://localhost:8081`. Adjust `WS_PORT` or `UDP_PORT` in `main.ts` if needed.

## Build executables manually
Compile self-contained binaries for different platforms:
```bash
bun build main.ts --compile --target=bun-linux-x64-modern --outfile dist/udp-ws-bridge
```
Repeat with targets you need:
- `--target=bun-linux-x64-modern`
- `--target=bun-windows-x64-modern` (adds `.exe`)
- `--target=bun-darwin-x64`
- `--target=bun-darwin-arm64`

## How it works
- Listens on UDP port 6454 (Art-Net) and broadcasts to all connected WebSocket clients on port 8081.
- WebSocket messages of type `udp-send` are forwarded to the target UDP address/port.
- WebSocket messages of type `udp-send-no-echo` are forwarded to the target UDP address/port, but any echo/loopback of that exact message is filtered out.
- Runs entirely on Bun (no extra deps).

## WebSocket JSON
Messages exchanged between the browser/client and the bridge are JSON strings.

- Incoming from UDP to browser (`udp-message`):
  ```json
  {
    "type": "udp-message",
    "address": "192.168.1.50",
    "port": 6454,
    "data": [0, 16, 32, 255]
  }
  ```
  - `type`: fixed string `udp-message`.
  - `address`: source IP of the UDP datagram.
  - `port`: source port of the UDP datagram.
  - `data`: byte array of the datagram payload.

- Outgoing from browser to UDP (`udp-send`):
  ```json
  {
    "type": "udp-send",
    "address": "255.255.255.255",
    "port": 6454,
    "data": [0, 16, 32, 255]
  }
  ```
  - `type`: fixed string `udp-send`.
  - `address`: destination IP (can be broadcast if enabled).
  - `port`: destination UDP port.
  - `data`: byte array payload to send.

- Outgoing from browser to UDP without echo (`udp-send-no-echo`):
  ```json
  {
    "type": "udp-send-no-echo",
    "address": "127.0.0.1",
    "port": 6454,
    "data": [0, 16, 32, 255]
  }
  ```
  - `type`: fixed string `udp-send-no-echo`.
  - `address`: destination IP.
  - `port`: destination UDP port.
  - `data`: byte array payload to send.
  - **Purpose**: Sends a UDP message but filters out any echo/loopback of the same message. Useful when sending to localhost or broadcast addresses where the same message might be received back on the same socket.

### Notes
- `data` is always an array of unsigned bytes (0–255). The bridge converts it to a `Buffer` when sending.
- The UDP socket is bound to port `6454` and broadcast is enabled; adjust in `main.ts` if needed.
- Invalid JSON or unknown `type` is logged and ignored by the bridge.
- Echo filtering (for `udp-send-no-echo`) matches messages by exact data, address, and port, with a 100ms window.
