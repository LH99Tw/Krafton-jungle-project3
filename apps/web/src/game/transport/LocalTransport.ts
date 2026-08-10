import type { GameTransport, TransportMessage } from "./GameTransport";

export class LocalTransport implements GameTransport {
  readonly kind = "local" as const;
  private listeners = new Set<(message: TransportMessage) => void>();

  async connect(): Promise<void> {
    return Promise.resolve();
  }

  send(message: TransportMessage): void {
    queueMicrotask(() => {
      this.listeners.forEach((listener) => listener(message));
    });
  }

  subscribe(listener: (message: TransportMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  disconnect(): void {
    this.listeners.clear();
  }
}

