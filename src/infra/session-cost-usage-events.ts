import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";

type UsagePublication = { usageUpdatedAt: number; usageRefreshFailed?: true };

const publications = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionCostUsagePublications"),
  () => ({ updatedAt: 0, listeners: new Set<(event: UsagePublication) => void>() }),
  (state) => state.listeners.clear(),
);

export function getSessionCostUsageUpdatedAt(): number {
  return publications.updatedAt;
}

export function onSessionCostUsageUpdated(listener: (event: UsagePublication) => void): () => void {
  return registerListener(publications.listeners, listener);
}

export function publishSessionCostUsageUpdated(failed = false): void {
  publications.updatedAt = Math.max(Date.now(), publications.updatedAt + 1);
  notifyListeners(publications.listeners, {
    usageUpdatedAt: publications.updatedAt,
    ...(failed ? { usageRefreshFailed: true } : {}),
  });
}
