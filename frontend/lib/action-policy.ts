/** Stale data must never authorize trading or resuming automatic paper actions.
 * A manual stop is risk-reducing and can be sent even if analytics is stale,
 * provided the authenticated session, foreground network and HTTPS are usable.
 */
export function assertActionAllowed(state: {
  path: string;
  fresh: boolean;
  visible: boolean;
  online: boolean;
  locked: boolean;
  secure: boolean;
}) {
  if (state.locked)
    throw new Error("Sitzung gesperrt · API-Token erneut bestätigen");
  if (!state.visible || !state.online)
    throw new Error("Aktive Netzwerkverbindung erforderlich");
  if (!state.secure)
    throw new Error("Vertrauenswürdige HTTPS-Verbindung erforderlich");
  if (!state.fresh && state.path !== "/api/risk/kill?active=true") {
    throw new Error("Frische Verbindung erforderlich · Bitte erneut verbinden");
  }
}
