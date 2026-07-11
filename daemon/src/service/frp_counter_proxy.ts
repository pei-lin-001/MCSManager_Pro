import net from "net";
import EventEmitter from "events";

export type TrafficSnapshot = {
  rxBytes: number;
  txBytes: number;
  connections: number;
};

/**
 * High-precision bidirectional byte counter for a single game port tunnel.
 *
 * Topology:
 *   frpc --> 127.0.0.1:listenPort (this proxy) --> 127.0.0.1:targetPort (game)
 *
 * rxBytes = bytes from public/frpc side into the proxy (player download from server? actually:
 *   - data received on the public-facing socket (from frpc/player direction into local app path)
 * We define:
 *   rxBytes: bytes received from the frpc/public side (inbound to game host)
 *   txBytes: bytes sent to the frpc/public side (outbound from game host)
 * This is bidirectional business traffic through the tunnel only.
 */
export class TcpTrafficCounterProxy extends EventEmitter {
  private server?: net.Server;
  private listenPort = 0;
  private closed = false;
  private active = new Set<net.Socket>();
  rxBytes = 0;
  txBytes = 0;

  constructor(
    public readonly targetHost: string,
    public readonly targetPort: number
  ) {
    super();
  }

  async start(): Promise<number> {
    if (this.server) return this.listenPort;
    this.closed = false;

    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((publicSocket) => {
        if (this.closed) {
          publicSocket.destroy();
          return;
        }
        this.active.add(publicSocket);
        const gameSocket = net.createConnection({
          host: this.targetHost,
          port: this.targetPort
        });
        this.active.add(gameSocket);

        publicSocket.on("data", (buf) => {
          this.rxBytes += buf.length;
          if (!gameSocket.destroyed) gameSocket.write(buf);
        });
        gameSocket.on("data", (buf) => {
          this.txBytes += buf.length;
          if (!publicSocket.destroyed) publicSocket.write(buf);
        });

        const cleanup = () => {
          this.active.delete(publicSocket);
          this.active.delete(gameSocket);
          if (!publicSocket.destroyed) publicSocket.destroy();
          if (!gameSocket.destroyed) gameSocket.destroy();
        };
        publicSocket.on("error", cleanup);
        gameSocket.on("error", cleanup);
        publicSocket.on("close", cleanup);
        gameSocket.on("close", cleanup);
      });

      server.once("error", reject);
      // bind ephemeral local port on loopback only
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") {
          reject(new Error("counter proxy failed to bind"));
          return;
        }
        this.listenPort = addr.port;
        this.server = server;
        resolve();
      });
    });

    return this.listenPort;
  }

  snapshot(): TrafficSnapshot {
    return {
      rxBytes: this.rxBytes,
      txBytes: this.txBytes,
      connections: Math.floor(this.active.size / 2)
    };
  }

  async stop() {
    this.closed = true;
    for (const s of this.active) {
      try {
        s.destroy();
      } catch {
        // ignore
      }
    }
    this.active.clear();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = undefined;
    });
  }
}
