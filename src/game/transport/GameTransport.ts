export type TransportMessage = {
  type: string;
  payload: unknown;
  at: number;
};

export interface GameTransport {
  readonly kind: "local" | "websocket";
  connect(): Promise<void>;
  send(message: TransportMessage): void;
  subscribe(listener: (message: TransportMessage) => void): () => void;
  disconnect(): void;
}

