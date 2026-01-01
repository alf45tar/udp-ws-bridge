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
  data: number[] | Buffer;
}

class WSClient {
  private ws: WebSocket | null = null;
  private url: string;
  private messageHandlers: ((msg: UDPMessage) => void)[] = [];
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;

  constructor(url: string = "ws://localhost:8081") {
    this.url = url;
  }

  /**
   * Connect to the WebSocket server
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);

        this.ws.onopen = () => {
          console.log(`[Client] Connected to ${this.url}`);
          this.reconnectAttempts = 0;
          resolve();
        };

        this.ws.onmessage = (event: MessageEvent) => {
          try {
            const msg = JSON.parse(event.data);
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
          this.attemptReconnect();
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

    const msg = {
      type: "udp-send",
      address: options.address || "127.0.0.1",
      port: options.port || 6454,
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

    const msg = {
      type: "udp-send-no-echo",
      address: options.address || "127.0.0.1",
      port: options.port || 6454,
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
      this.ws.close();
      this.ws = null;
    }
  }
}

export default WSClient;
