import { PlatformMessageNotDispatchedError } from "./deliver-types.js";
import { getSessionBindingService } from "./session-binding-service.js";
import type { ConversationRef } from "./session-binding.types.js";

/** Durable proof that an ACP child owned a conversation when its reply was queued. */
export type AcpConversationBindingAuthority = {
  targetSessionKey: string;
  bindingId: string;
  boundAt: number;
  conversation: ConversationRef;
};

/** Whether the conversation is still bound to the same child by the same binding. */
export async function isAcpConversationBindingCurrent(
  authority: AcpConversationBindingAuthority,
): Promise<boolean> {
  const current = await getSessionBindingService()
    .resolveByConversationAsync(authority.conversation)
    .catch(() => null);
  return (
    current?.bindingId === authority.bindingId &&
    current.boundAt === authority.boundAt &&
    current.targetSessionKey === authority.targetSessionKey
  );
}

/** Rejects a recovered send whose ACP conversation binding was removed or reassigned. */
export async function assertAcpConversationBindingCurrent(
  authority: AcpConversationBindingAuthority | undefined,
): Promise<void> {
  if (authority && !(await isAcpConversationBindingCurrent(authority))) {
    throw new PlatformMessageNotDispatchedError("ACP conversation binding was revoked", {
      cause: undefined,
      retryable: false,
    });
  }
}

// Enumerable so the selection survives context spreads; never serialized into payloads.
const GATHERED_ACP_BINDING = Symbol.for("openclaw.gatheredAcpConversationBinding");
type GatheredCarrier = { [GATHERED_ACP_BINDING]?: AcpConversationBindingAuthority };

/** Retains the binding that routed this turn to an ACP child at gather time. */
export function retainGatheredAcpBinding(
  ctx: object,
  authority: AcpConversationBindingAuthority,
): void {
  (ctx as GatheredCarrier)[GATHERED_ACP_BINDING] = {
    ...authority,
    conversation: { ...authority.conversation },
  };
}

export function readGatheredAcpBinding(ctx: object): AcpConversationBindingAuthority | undefined {
  return (ctx as GatheredCarrier)[GATHERED_ACP_BINDING];
}
