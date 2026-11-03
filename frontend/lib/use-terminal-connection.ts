"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import {
  TerminalConnection,
  type ConnectionState,
  type Socket,
} from "./connection";
import type { Snapshot } from "../app/types";

export function useTerminalConnection(
  token: string,
  onSnapshot: (snapshot: Snapshot) => void,
  locked = false,
) {
  const callback = useRef(onSnapshot);
  callback.current = onSnapshot;
  const controller = useRef<TerminalConnection | null>(null);
  const [state, setState] = useState<ConnectionState>({
    ready: false,
    transport: "Verbinden…",
    error: "",
  });
  useEffect(() => {
    if (locked) {
      setState({
        ready: false,
        transport: "Gesperrt",
        error: "Sitzung gesperrt · API-Token erneut bestätigen",
      });
      return;
    }
    const fallback =
      location.port === "3000"
        ? `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.hostname}:8000/ws`
        : `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
    const connection = new TerminalConnection({
      token,
      wsURL: process.env.NEXT_PUBLIC_WS_URL || fallback,
      onSnapshot: (data) => callback.current(data),
      onState: setState,
      runtime: {
        now: () => performance.now(),
        fetch: (url, init) => fetch(url, init),
        socket: (url) => new WebSocket(url) as unknown as Socket,
        interval: (fn, ms) => window.setInterval(fn, ms),
        clearInterval: (id) => window.clearInterval(id as number),
        timeout: (fn, ms) => window.setTimeout(fn, ms),
        clearTimeout: (id) => window.clearTimeout(id as number),
      },
    });
    controller.current = connection;
    const resume = () => {
      if (document.hidden) connection.suspend();
      else if (!navigator.onLine)
        connection.suspend("Offline · Keine Paper-Aktionen möglich");
      else connection.resume();
    };
    const hide = () => connection.suspend();
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    window.addEventListener("offline", resume);
    window.addEventListener("pageshow", resume);
    window.addEventListener("pagehide", hide);
    resume();
    return () => {
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", resume);
      window.removeEventListener("offline", resume);
      window.removeEventListener("pageshow", resume);
      window.removeEventListener("pagehide", hide);
      connection.suspend("");
      if (controller.current === connection) controller.current = null;
    };
  }, [token, locked]);
  const isFresh = useCallback(
    () =>
      !document.hidden && navigator.onLine && !!controller.current?.isFresh(),
    [],
  );
  const suspend = useCallback(
    () => controller.current?.suspend("Sitzung gesperrt"),
    [],
  );
  return { ...state, isFresh, suspend };
}
