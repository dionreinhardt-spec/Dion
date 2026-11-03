import type { Snapshot } from "../app/types.ts";

export type ConnectionState = {
  ready: boolean;
  transport: string;
  error: string;
};
export type Socket = {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
};
export type Runtime = {
  now(): number;
  fetch(
    input: string,
    init: RequestInit,
  ): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  socket(url: string): Socket;
  interval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
  timeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
};

/** One foreground session owns its sockets, timers and HTTP requests.
 * Epoch checks reject late callbacks after standby, logout or reconnect.
 * Authentication is a first WS frame / HTTP header, never a query parameter.
 */
export class TerminalConnection {
  private active = false;
  private epoch = 0;
  private socket: Socket | null = null;
  private interval: unknown;
  private retry: unknown;
  private request: AbortController | null = null;
  private fetchingEpoch: number | null = null;
  private receivedAt: number | null = null;
  private socketFrameAt: number | null = null;
  private serverTime: number | null = null;
  private state: ConnectionState = {
    ready: false,
    transport: "Verbinden…",
    error: "",
  };

  private options: {
    token: string;
    wsURL: string;
    runtime: Runtime;
    onSnapshot(data: Snapshot): void;
    onState(state: ConnectionState): void;
  };
  constructor(options: {
    token: string;
    wsURL: string;
    runtime: Runtime;
    onSnapshot(data: Snapshot): void;
    onState(state: ConnectionState): void;
  }) {
    this.options = options;
  }

  private set(patch: Partial<ConnectionState>) {
    this.state = { ...this.state, ...patch };
    this.options.onState(this.state);
  }

  isFresh() {
    return (
      this.active &&
      this.state.ready &&
      this.receivedAt !== null &&
      this.options.runtime.now() - this.receivedAt <= 6000
    );
  }

  resume() {
    this.suspend("");
    this.active = true;
    const epoch = this.epoch;
    this.set({
      ready: false,
      transport: "Verbinden…",
      error: "Frische Daten werden angefordert…",
    });
    void this.poll(epoch);
    this.connect(epoch);
    this.interval = this.options.runtime.interval(() => {
      if (!this.current(epoch)) return;
      const now = this.options.runtime.now();
      if (this.receivedAt === null || now - this.receivedAt > 6000) {
        this.set({
          ready: false,
          error: "Daten veraltet · Paper-Aktionen gesperrt",
        });
      }
      if (
        this.socket?.readyState === 1 &&
        this.socketFrameAt !== null &&
        now - this.socketFrameAt > 6000
      ) {
        this.socket.close();
      }
      void this.poll(epoch);
    }, 1000);
  }

  suspend(reason = "App pausiert · Frische Daten nach Rückkehr erforderlich") {
    this.active = false;
    this.epoch += 1;
    if (this.interval !== undefined)
      this.options.runtime.clearInterval(this.interval);
    if (this.retry !== undefined) this.options.runtime.clearTimeout(this.retry);
    this.interval = this.retry = undefined;
    this.request?.abort();
    this.request = null;
    this.fetchingEpoch = null;
    if (this.socket) {
      this.socket.onopen =
        this.socket.onmessage =
        this.socket.onclose =
        this.socket.onerror =
          null;
      this.socket.close();
      this.socket = null;
    }
    this.receivedAt = this.socketFrameAt = null;
    this.serverTime = null;
    this.set({ ready: false, error: reason });
  }

  private current(epoch: number) {
    return this.active && this.epoch === epoch;
  }

  private accept(value: unknown, epoch: number, transport: string) {
    if (!this.current(epoch)) return;
    const data = value as Snapshot;
    if (
      !data ||
      !Array.isArray(data.scanner) ||
      !data.system ||
      !data.portfolio ||
      !Number.isFinite(data.server_time)
    ) {
      throw new Error("Ungültige Backend-Antwort");
    }
    if (this.serverTime !== null && data.server_time <= this.serverTime)
      return false;
    this.serverTime = data.server_time;
    this.receivedAt = this.options.runtime.now();
    const tick = data.system.last_tick_at;
    const engineFresh =
      typeof tick === "number" &&
      data.server_time - tick <= 5 &&
      data.server_time >= tick;
    this.set({
      ready: engineFresh,
      transport,
      error: engineFresh
        ? ""
        : "Backend-Auswertung veraltet · Paper-Aktionen gesperrt",
    });
    this.options.onSnapshot(data);
    return true;
  }

  private async poll(epoch: number) {
    if (!this.current(epoch) || this.fetchingEpoch === epoch) return;
    if (
      this.socket?.readyState === 1 &&
      this.socketFrameAt !== null &&
      this.options.runtime.now() - this.socketFrameAt <= 6000
    )
      return;
    this.fetchingEpoch = epoch;
    const controller = new AbortController();
    this.request = controller;
    const timeout = this.options.runtime.timeout(
      () => controller.abort(),
      8000,
    );
    try {
      const response = await this.options.runtime.fetch("/api/snapshot", {
        cache: "no-store",
        signal: controller.signal,
        headers: this.options.token
          ? { Authorization: "Bearer " + this.options.token }
          : {},
      });
      if (!response.ok)
        throw new Error(
          response.status === 401
            ? "API-Token erforderlich · Verbindung öffnen"
            : "Backend nicht erreichbar (" + response.status + ")",
        );
      this.accept(await response.json(), epoch, "REST · 1s");
    } catch (error) {
      if (this.current(epoch))
        this.set({
          ready: false,
          error:
            error instanceof Error && error.name !== "AbortError"
              ? error.message
              : "Verbindung unterbrochen · Erneuter Versuch folgt",
        });
    } finally {
      this.options.runtime.clearTimeout(timeout);
      if (this.fetchingEpoch === epoch) this.fetchingEpoch = null;
      if (this.request === controller) this.request = null;
    }
  }

  private connect(epoch: number) {
    if (!this.current(epoch)) return;
    try {
      const socket = this.options.runtime.socket(this.options.wsURL);
      this.socket = socket;
      this.socketFrameAt = this.options.runtime.now();
      socket.onopen = () => {
        if (!this.current(epoch) || this.socket !== socket) return;
        if (this.options.token)
          socket.send(JSON.stringify({ token: this.options.token }));
      };
      socket.onmessage = (event) => {
        if (!this.current(epoch) || this.socket !== socket) return;
        try {
          if (this.accept(JSON.parse(event.data), epoch, "WebSocket · 1s"))
            this.socketFrameAt = this.options.runtime.now();
        } catch {
          this.set({
            ready: false,
            error: "Ungültiges Datenpaket · Paper-Aktionen gesperrt",
          });
          socket.close();
        }
      };
      socket.onclose = () => {
        if (!this.current(epoch) || this.socket !== socket) return;
        this.socket = null;
        this.socketFrameAt = null;
        this.set({
          ready: false,
          error: "Stream getrennt · REST-Verbindung wird geprüft",
        });
        void this.poll(epoch);
        this.retry = this.options.runtime.timeout(
          () => this.connect(epoch),
          8000,
        );
      };
      socket.onerror = () => socket.close();
    } catch {
      this.retry = this.options.runtime.timeout(
        () => this.connect(epoch),
        8000,
      );
    }
  }
}
