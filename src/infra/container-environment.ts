// Detects container runtimes and related environment hints for diagnostics.
import fs from "node:fs";
import { isTruthyEnvValue } from "./env.js";

/**
 * Detect whether the current process is running inside a container
 * (Docker, Podman, Kubernetes, Fly Machines, or Cloudflare Containers).
 *
 * Preference order:
 * 1. Explicit operator override via `OPENCLAW_CONTAINER` (capability/config
 *    escape hatch — set `1`/`true` to force container, `0`/`false` to force host).
 * 2. Documented platform runtime env vars (Fly, Cloudflare Containers) rather
 *    than inventing hostname or undocumented cgroup heuristics.
 * 3. Common container sentinel files.
 * 4. Well-known container entries in `/proc/1/cgroup`.
 *
 * Cloudflare Containers automatically set `CLOUDFLARE_APPLICATION_ID` and
 * `CLOUDFLARE_DURABLE_OBJECT_ID` inside the instance:
 * https://developers.cloudflare.com/containers/configuration/environment-variables/
 * The Sandbox SDK runs on Containers, but whether those vars propagate into
 * sandbox *user* processes is unverified — do not assume Sandbox coverage.
 *
 * Security: a positive result enables shared container defaults, including
 * binding the gateway to all interfaces. `OPENCLAW_CONTAINER=1` on a normal
 * host therefore exposes the gateway to the network; `OPENCLAW_CONTAINER=0`
 * is the safe opt-out when sniffing would otherwise misclassify.
 *
 * The result is cached after the first call so filesystem access happens at
 * most once per process lifetime.
 */
let containerEnvironmentCache: boolean | undefined;

export function isContainerEnvironment(): boolean {
  if (containerEnvironmentCache !== undefined) {
    return containerEnvironmentCache;
  }
  containerEnvironmentCache = detectContainerEnvironment();
  return containerEnvironmentCache;
}

function readContainerOverride(): boolean | undefined {
  const raw = process.env.OPENCLAW_CONTAINER?.trim();
  if (!raw) {
    return undefined;
  }
  // Explicit falsey values force "not a container" (skip platform sniffing).
  if (/^(0|false|no|off)$/i.test(raw)) {
    return false;
  }
  return isTruthyEnvValue(raw);
}

/** Documented Cloudflare Containers runtime env vars (not user/custom vars). */
function hasCloudflareContainerRuntimeEnv(): boolean {
  return Boolean(
    process.env.CLOUDFLARE_APPLICATION_ID?.trim() ||
      process.env.CLOUDFLARE_DURABLE_OBJECT_ID?.trim(),
  );
}

function detectContainerEnvironment(): boolean {
  const override = readContainerOverride();
  if (override !== undefined) {
    return override;
  }

  if (process.env.FLY_MACHINE_ID?.trim() && process.env.FLY_APP_NAME?.trim()) {
    return true;
  }

  if (hasCloudflareContainerRuntimeEnv()) {
    return true;
  }

  for (const sentinelPath of ["/.dockerenv", "/run/.containerenv", "/var/run/.containerenv"]) {
    try {
      fs.accessSync(sentinelPath, fs.constants.F_OK);
      return true;
    } catch {
      // Not present; try the next signal.
    }
  }

  try {
    const cgroup = fs.readFileSync("/proc/1/cgroup", "utf8");
    if (
      /\/docker\/|cri-containerd-[0-9a-f]|containerd\/[0-9a-f]{64}|\/kubepods[/.]|\blxc\b/.test(
        cgroup,
      )
    ) {
      return true;
    }
  } catch {
    // /proc may not exist on non-Linux platforms.
  }

  return false;
}

/** @internal test helper */
export function resetContainerEnvironmentCacheForTest(): void {
  containerEnvironmentCache = undefined;
}
