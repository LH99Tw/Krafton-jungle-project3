declare module "@fails-components/webtransport" {
  export type WebTransportSession = {
    ready: Promise<void>;
    closed: Promise<{ closeCode?: number; reason?: string }>;
    datagrams: {
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<Uint8Array>;
    };
    close(info: { closeCode: number; reason: string }): void;
  };

  export class Http3Server {
    constructor(options: {
      host: string;
      port: number;
      secret: string;
      cert: string | string[];
      privKey: string | string[];
      maxConnections?: number;
    });
    readonly ready: Promise<unknown>;
    setRequestCallback(callback: (request: { header: Record<string, unknown> }) => Promise<{
      status: number;
      path: string;
      header: Record<string, unknown>;
    }>): void;
    startServer(): void;
    stopServer(): void;
    sessionStream(path: string): ReadableStream<WebTransportSession>;
  }
}
