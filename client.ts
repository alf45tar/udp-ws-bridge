// -------------------------
// WebSocket Client for UDP-WS Bridge
// -------------------------

interface UDPMessage {
  type: "udp-message";
  address: string;
  port: number;
  data: number[];
}

interface SendOptions {
  address?: string;
  port?: number;
  data: number[] | Buffer | Uint8Array;
}

type ClientMode = "json" | "binary";

class WSClient {
  private ws: WebSocket | null = null;
  private url: string;
  private mode: ClientMode;
  private messageHandlers: ((msg: UDPMessage) => void)[] = [];
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private intentionalClose = false;

  constructor(url: string = "ws://localhost:8081", mode: ClientMode = "json") {
    this.mode = mode;
    this.url = this.applyMode(url, mode);
  }

  /**
   * Connect to the WebSocket server
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const protocols = this.mode === "binary" ? ["binary"] : undefined;
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore Bun/Web standards accept string | string[] | undefined
        this.ws = new WebSocket(this.url, protocols);

        this.ws.onopen = () => {
          console.log(`[Client] Connected to ${this.url}`);
          this.reconnectAttempts = 0;
          this.intentionalClose = false;
          resolve();
        };

        this.ws.onmessage = (event: MessageEvent) => {
          try {
            if (this.mode === "binary" && typeof event.data !== "string") {
              const view = this.asUint8Array(event.data);

              if (view.length < 10) return;
              if (view[0] !== 1) return; // protocol version

              const type = view[1];
              if (type !== 0x01) return; // only udp-message from bridge

              const port = (view[2] << 8) | view[3];
              const address = `${view[4]}.${view[5]}.${view[6]}.${view[7]}`;
              const len = (view[8] << 8) | view[9];
              if (len !== view.length - 10) return;
              const payload = view.subarray(10);

              const msg: UDPMessage = {
                type: "udp-message",
                address,
                port,
                data: Array.from(payload),
              };

              this.messageHandlers.forEach((handler) => handler(msg));
              return;
            }

            // JSON path
            const msg = JSON.parse(event.data as string);
            if (msg.type === "udp-message") {
              this.messageHandlers.forEach((handler) => handler(msg));
            }
          } catch (err) {
            console.error("[Client] Failed to parse message:", err);
          }
        };

        this.ws.onerror = (err: Event) => {
          console.error("[Client] WebSocket error:", err);
          reject(err);
        };

        this.ws.onclose = () => {
          console.log("[Client] Disconnected from server");
          if (!this.intentionalClose) {
            this.attemptReconnect();
          }
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Attempt to reconnect with exponential backoff
   */
  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("[Client] Max reconnect attempts reached");
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    console.log(`[Client] Attempting reconnect in ${delay}ms...`);

    setTimeout(() => {
      this.connect().catch((err) => {
        console.error("[Client] Reconnect failed:", err);
      });
    }, delay);
  }

  /**
   * Send a UDP message through the bridge
   */
  sendUDP(options: SendOptions): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("[Client] WebSocket is not connected");
    }

    const data = Array.isArray(options.data)
      ? options.data
      : Array.from(options.data);

    const address = options.address || "127.0.0.1";
    const port = options.port || 6454;

    if (this.mode === "binary") {
      this.ws.send(this.buildBinaryFrame(0x02, address, port, data));
      return;
    }

    const msg = {
      type: "udp-send",
      address,
      port,
      data,
    };

    this.ws.send(JSON.stringify(msg));
  }

  /**
   * Send a UDP message through the bridge without echoing back
   * (filters out loopback/echo messages)
   */
  sendUDPNoEcho(options: SendOptions): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("[Client] WebSocket is not connected");
    }

    const data = Array.isArray(options.data)
      ? options.data
      : Array.from(options.data);

    const address = options.address || "127.0.0.1";
    const port = options.port || 6454;

    if (this.mode === "binary") {
      this.ws.send(this.buildBinaryFrame(0x03, address, port, data));
      return;
    }

    const msg = {
      type: "udp-send-no-echo",
      address,
      port,
      data,
    };

    this.ws.send(JSON.stringify(msg));
  }

  /**
   * Register a handler for incoming UDP messages
   */
  onMessage(handler: (msg: UDPMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  /**
   * Clear all message handlers
   */
  clearHandlers(): void {
    this.messageHandlers = [];
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Disconnect from the server
   */
  disconnect(): void {
    if (this.ws) {
      this.intentionalClose = true;
      this.ws.close();
      this.ws = null;
    }
  }

  private applyMode(url: string, mode: ClientMode): string {
    if (mode !== "binary") return url;
    const parsed = new URL(url);
    parsed.searchParams.set("mode", "binary");
    return parsed.toString();
  }

  private asUint8Array(data: any): Uint8Array {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    // Bun may deliver Buffer
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    if (typeof Buffer !== "undefined" && data instanceof Buffer) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    throw new Error("Unsupported binary payload");
  }

  private ipToBytes(address: string): number[] {
    return address.split(".").map((octet) => Number(octet) & 0xff);
  }

  private buildBinaryFrame(
    type: 0x02 | 0x03,
    address: string,
    port: number,
    data: number[] | Uint8Array | Buffer
  ): Uint8Array {
    const payload =
      data instanceof Uint8Array
        ? data
        : Array.isArray(data)
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const header = new Uint8Array(10);
    header[0] = 1; // version
    header[1] = type;
    header[2] = (port >> 8) & 0xff;
    header[3] = port & 0xff;
    header.set(this.ipToBytes(address), 4);
    header[8] = (payload.length >> 8) & 0xff;
    header[9] = payload.length & 0xff;

    const frame = new Uint8Array(header.length + payload.length);
    frame.set(header, 0);
    frame.set(payload, header.length);
    return frame;
  }
}

export default WSClient;
