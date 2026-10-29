import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { FinalizedMsgContext } from "../templating.js";
import { createAcpBoundDeliveryRevocation } from "./dispatch-acp-delivery-binding.js";
import { createAcpTestReplyDispatcher } from "./test-fixtures/acp-runtime.js";

const state = vi.hoisted(() => ({
  session: { entry: { spawnedBy: "agent:main:parent" }, acp: {} } as Record<string, unknown>,
  binding: null as Record<string, unknown> | null,
  readThrows: false,
}));

// mock-isolation: binding revalidation is tested against fixed session/binding state, not real stores
vi.mock("../../acp/runtime/session-meta-read.js", () => ({
  withAcpSessionEntryRead: async (_params: unknown, read: (session: unknown) => unknown) => {
    if (state.readThrows) {
      throw new Error("session store unavailable");
    }
    return read(state.session);
  },
}));
// mock-isolation: binding revalidation is tested against fixed session/binding state, not real stores
vi.mock("@openclaw/acp-core/session-interaction-mode", () => ({
  isParentOwnedBackgroundAcpSession: (entry?: { spawnedBy?: string }) => Boolean(entry?.spawnedBy),
}));
// mock-isolation: binding revalidation is tested against fixed session/binding state, not real stores
vi.mock("../../infra/outbound/session-binding-service.js", () => ({
  getSessionBindingService: () => ({ resolveByConversationAsync: async () => state.binding }),
}));

const CHILD = "agent:codex-acp:child";
const conversation = { channel: "discord", accountId: "default", conversationId: "thread-1" };
const bindingRecord = { bindingId: "b1", boundAt: 1, targetSessionKey: CHILD, conversation };
const cfg = {} as OpenClawConfig;

/** A channel turn the binding router already rewrote to the child key. */
function boundCtx(): FinalizedMsgContext {
  return Object.assign({ SessionKey: CHILD } as FinalizedMsgContext, {
    [Symbol.for("openclaw.conversationBindingRouteFacts")]: {
      kind: "agent",
      ...bindingRecord,
      targetKind: "session",
      bindingConversation: conversation,
      conversation,
      agentId: "codex-acp",
      fallbackAgentId: "codex-acp",
      observedAgentId: "codex-acp",
    },
  });
}

function revocation(ctx: FinalizedMsgContext, dispatcher = createAcpTestReplyDispatcher()) {
  return createAcpBoundDeliveryRevocation({ cfg, ctx, dispatcher }, undefined, CHILD);
}

describe("createAcpBoundDeliveryRevocation", () => {
  it("allows a still-bound child when the dispatcher can re-check before send", async () => {
    state.binding = bindingRecord;
    expect(await revocation(boundCtx())()).toBe(false);
  });

  it("keeps routed sends from a still-bound child without a dispatcher pre-send hook", async () => {
    state.binding = bindingRecord;
    const dispatcher = { ...createAcpTestReplyDispatcher(), appendBeforeDeliver: undefined };
    const isRevoked = revocation(boundCtx(), dispatcher);
    expect(await isRevoked()).toBe(false);
    expect(await isRevoked(true)).toBe(true); // a dispatcher-queued send cannot be re-checked
    state.binding = null;
    expect(await isRevoked()).toBe(true);
  });

  it("revokes a bound turn whose context key equals the child key once unbound", async () => {
    state.binding = bindingRecord;
    const isRevoked = revocation(boundCtx());
    state.binding = null;
    expect(await isRevoked()).toBe(true);
    state.binding = { ...bindingRecord, bindingId: "b2", targetSessionKey: "agent:other:x" };
    expect(await isRevoked()).toBe(true);
  });

  it("fails closed when the session store read fails or throws", async () => {
    state.binding = bindingRecord;
    state.session = { storeReadFailed: true };
    try {
      expect(await revocation(boundCtx())()).toBe(true);
      state.readThrows = true;
      expect(await revocation(boundCtx())()).toBe(true);
    } finally {
      state.readThrows = false;
      state.session = { entry: { spawnedBy: "agent:main:parent" }, acp: {} };
    }
  });
});
