import type {
  BuildMode,
  GameResult,
  GameSnapshot,
  GameStartOptions,
  UpgradeChoice,
  UpgradeId,
} from "../domain/types";

type BridgeEvents = {
  snapshot: GameSnapshot;
  upgrade: UpgradeChoice[];
  result: GameResult;
  ready: undefined;
  message: string;
};

type BridgeEventName = keyof BridgeEvents;
type Listener<T> = (payload: T) => void;

export class GameBridge {
  private readonly target = new EventTarget();
  private commandHandler: ((command: GameCommand) => void) | null = null;

  on<K extends BridgeEventName>(event: K, listener: Listener<BridgeEvents[K]>): () => void {
    const wrapped = (nativeEvent: Event) => listener((nativeEvent as CustomEvent<BridgeEvents[K]>).detail);
    this.target.addEventListener(event, wrapped);
    return () => this.target.removeEventListener(event, wrapped);
  }

  emit<K extends BridgeEventName>(event: K, payload: BridgeEvents[K]): void {
    this.target.dispatchEvent(new CustomEvent(event, { detail: payload }));
  }

  connect(handler: (command: GameCommand) => void): () => void {
    this.commandHandler = handler;
    return () => {
      if (this.commandHandler === handler) this.commandHandler = null;
    };
  }

  command(command: GameCommand): void {
    this.commandHandler?.(command);
  }
}

export type GameCommand =
  | { type: "start"; options: GameStartOptions }
  | { type: "choose-upgrade"; upgradeId: UpgradeId }
  | { type: "set-build-mode"; buildMode: BuildMode }
  | { type: "enter-boss" }
  | { type: "return-base" }
  | { type: "restart" };

export const gameBridge = new GameBridge();

