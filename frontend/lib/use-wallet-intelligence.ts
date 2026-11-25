"use client";
import { useEffect, useState } from "react";
import type { IntelligenceSnapshot } from "./wallet-intelligence";
import { isSolanaAddress } from "./coin-chart";

export function useWalletIntelligence() {
  const [snapshot, setSnapshot] = useState<IntelligenceSnapshot | null>(null), [error, setError] = useState(""), [clock, setClock] = useState(() => Date.now() / 1000);
  useEffect(() => {
    let disposed = false, generation = 0, controller: AbortController | null = null, timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => { generation++; clearTimeout(timer); controller?.abort(); };
    const load = async () => {
      clearTimeout(timer); setClock(Date.now() / 1000);
      if (disposed || document.hidden || !navigator.onLine) return;
      const request = ++generation; controller?.abort(); controller = new AbortController();
      try {
        const response = await fetch("/api/intelligence", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Wallet-Daten momentan nicht erreichbar.");
        const body = await response.json() as IntelligenceSnapshot;
        if (!Number.isFinite(body.serverTime) || !body.status || !Array.isArray(body.wallets) || !Array.isArray(body.tokens) || body.tokens.some(t => t.chain !== "solana" || !isSolanaAddress(t.token) || !Array.isArray(t.kol))) throw new Error("Wallet-Daten nicht eindeutig zugeordnet.");
        if (disposed || request !== generation) return;
        setSnapshot(body); setClock(Math.max(Date.now() / 1000, body.serverTime)); setError("");
      } catch (failure) {
        if (disposed || request !== generation || (failure instanceof Error && failure.name === "AbortError")) return;
        setError(failure instanceof Error ? failure.message : "Wallet-Daten momentan nicht erreichbar."); setClock(Date.now() / 1000);
      } finally {
        if (!disposed && request === generation && !document.hidden && navigator.onLine) timer = setTimeout(() => void load(), 30_000);
      }
    };
    const resume = () => { cancel(); setClock(Date.now() / 1000); if (!document.hidden && navigator.onLine) void load(); };
    document.addEventListener("visibilitychange", resume); window.addEventListener("online", resume); window.addEventListener("offline", resume); void load();
    return () => { disposed = true; cancel(); document.removeEventListener("visibilitychange", resume); window.removeEventListener("online", resume); window.removeEventListener("offline", resume); };
  }, []);
  return { snapshot, error, now: clock };
}
