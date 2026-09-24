import { runPluginCleanup } from "../../plugins/plugin-instance-scope.js";
import type { AgentHarness } from "./types.js";

const disposals = new WeakMap<AgentHarness, Promise<void>>();

/** Plugin retirement and terminal CLI cleanup join the same physical teardown. */
export function disposeAgentHarnessOnce(harness: AgentHarness): Promise<void> {
  let disposal = disposals.get(harness);
  if (!disposal) {
    disposal = Promise.resolve().then(() => runPluginCleanup(harness, () => harness.dispose?.()));
    disposals.set(harness, disposal);
  }
  return disposal;
}
