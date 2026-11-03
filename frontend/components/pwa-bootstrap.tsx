"use client";
import { useEffect, useState } from "react";
import { Download, RefreshCw, X } from "lucide-react";
export function PwaBootstrap() {
  const [showInstall, setShowInstall] = useState(false);
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [activated, setActivated] = useState(false);
  useEffect(() => {
    let disposed = false;
    const standalone =
      matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone;
    setShowInstall(
      !standalone &&
        matchMedia(
          "(max-width: 767px), (max-height: 500px) and (pointer: coarse)",
        ).matches,
    );
    if (
      "serviceWorker" in navigator &&
      window.isSecureContext &&
      process.env.NODE_ENV === "production"
    ) {
      void navigator.serviceWorker
        .register("/sw.js", { scope: "/", updateViaCache: "none" })
        .then((registration) => {
          if (disposed) return;
          if (registration.waiting) setWaiting(registration.waiting);
          registration.addEventListener("updatefound", () => {
            const next = registration.installing;
            next?.addEventListener("statechange", () => {
              if (
                !disposed &&
                next.state === "installed" &&
                navigator.serviceWorker.controller
              )
                setWaiting(next);
            });
          });
        })
        .catch(() => {
          /* Normal online dashboard remains usable without offline support. */
        });
    }
    const controller = () => {
      if (!disposed) setActivated(true);
    };
    navigator.serviceWorker?.addEventListener("controllerchange", controller);
    return () => {
      disposed = true;
      navigator.serviceWorker?.removeEventListener(
        "controllerchange",
        controller,
      );
    };
  }, []);
  return (
    <>
      {showInstall && (
        <aside className="install-banner" aria-label="iPhone-App installieren">
          <Download size={19} />
          <div>
            <strong>Dein Terminal. Ein Fingertipp.</strong>
            <a href="/install">
              Zum Home-Bildschirm hinzufügen <span>↗</span>
            </a>
          </div>
          <button
            aria-label="Installationshinweis schließen"
            onClick={() => setShowInstall(false)}
          >
            <X size={17} />
          </button>
        </aside>
      )}
      {waiting && (
        <aside className="pwa-update" role="status">
          <RefreshCw size={15} />
          <span>
            {activated ? "Update bereit" : "Neue App-Version verfügbar"}
          </span>
          <button
            onClick={() =>
              activated
                ? location.reload()
                : waiting.postMessage({ type: "ACTIVATE_UPDATE" })
            }
          >
            {activated ? "Neu laden" : "Vorbereiten"}
          </button>
        </aside>
      )}
    </>
  );
}
