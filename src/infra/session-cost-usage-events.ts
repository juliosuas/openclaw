import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";

const publications = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionCostUsagePublications"),
  () => ({ updatedAt: 0, listeners: new Set<(updatedAt: number) => void>() }),
  (state) => state.listeners.clear(),
);

export function getSessionCostUsageUpdatedAt(): number {
  return publications.updatedAt;
}

export function onSessionCostUsageUpdated(listener: (updatedAt: number) => void): () => void {
  return registerListener(publications.listeners, listener);
}

export function publishSessionCostUsageUpdated(): void {
  publications.updatedAt = Math.max(Date.now(), publications.updatedAt + 1);
  notifyListeners(publications.listeners, publications.updatedAt);
}
