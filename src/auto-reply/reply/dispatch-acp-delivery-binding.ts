import { isParentOwnedBackgroundAcpSession } from "@openclaw/acp-core/session-interaction-mode";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { withAcpSessionEntryRead } from "../../acp/runtime/session-meta-read.js";
import { readConversationBindingRouteFacts } from "../../channels/conversation-binding-route-facts.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  type AcpConversationBindingAuthority,
  isAcpConversationBindingCurrent,
} from "../../infra/outbound/acp-binding-authority.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import type { FinalizedMsgContext } from "../templating.js";
import { resolveConversationBindingContextFromMessage } from "./conversation-binding-input.js";
import type { ReplyDispatcher } from "./reply-dispatcher.types.js";

/**
 * The binding that routed this turn to the child: the prepared route facts when the
 * channel attached them, else the conversation's binding read when delivery is set up.
 */
async function preparedAcpBinding(
  cfg: OpenClawConfig,
  ctx: FinalizedMsgContext,
  sessionKey: string,
): Promise<AcpConversationBindingAuthority | undefined> {
  const facts = readConversationBindingRouteFacts(ctx);
  if (facts) {
    return facts.kind === "agent" && facts.targetSessionKey === sessionKey
      ? {
          targetSessionKey: facts.targetSessionKey,
          bindingId: facts.bindingId,
          boundAt: facts.boundAt,
          conversation: { ...facts.bindingConversation },
        }
      : undefined;
  }
  const conversation = resolveConversationBindingContextFromMessage({ cfg, ctx });
  const binding = conversation
    ? await getSessionBindingService().resolveByConversationAsync(conversation)
    : null;
  return binding?.targetSessionKey === sessionKey
    ? {
        targetSessionKey: sessionKey,
        bindingId: binding.bindingId,
        boundAt: binding.boundAt,
        conversation: { ...binding.conversation },
      }
    : undefined;
}

/** `viaDispatcher`: the send is queued in the reply dispatcher, not routed. */
export type AcpBoundDeliveryRevocation = ((viaDispatcher?: boolean) => Promise<boolean>) & {
  /** Prepared binding authority retained by durable sends for recovery-time checks. */
  authority?: Promise<AcpConversationBindingAuthority | undefined>;
};

/**
 * A parent-owned ACP child may answer a conversation only while that conversation
 * is still bound to it. The prepared route facts say whether the turn was bound;
 * this re-checks that same binding at send time.
 */
export function createAcpBoundDeliveryRevocation(
  {
    cfg,
    ctx,
    dispatcher,
  }: { cfg: OpenClawConfig; ctx: FinalizedMsgContext; dispatcher: ReplyDispatcher },
  agentId: string | undefined,
  sessionKey: string,
): AcpBoundDeliveryRevocation {
  // A failed binding read (null) leaves no proof the turn was unbound: treat it as bound to nothing.
  const authority = preparedAcpBinding(cfg, ctx, sessionKey).catch(() => null);
  const isRevoked = async (viaDispatcher = false) => {
    const prepared = await authority;
    if (prepared === undefined) {
      return false; // Not routed by a binding: nothing can revoke it.
    }
    try {
      const parentOwned = await withAcpSessionEntryRead({ cfg, agentId, sessionKey }, (session) =>
        session?.storeReadFailed
          ? null
          : isParentOwnedBackgroundAcpSession(
              session?.entry ? { ...session.entry, acp: session.acp } : undefined,
            ),
      );
      if (parentOwned === false) {
        return false;
      }
      // Without a dispatcher pre-send hook a queued send cannot be re-checked at
      // transport; routed sends keep their own platform-send guard.
      if (parentOwned === null || (viaDispatcher && !dispatcher.appendBeforeDeliver)) {
        return true;
      }
      return !prepared || !(await isAcpConversationBindingCurrent(prepared));
    } catch {
      return true; // A failed or throwing session read cannot prove ownership: fail closed.
    }
  };
  return Object.assign(isRevoked, {
    authority: authority.then((prepared) => prepared ?? undefined),
  });
}

/** Whether the session has any binding on the dispatch channel and account. */
export async function hasBoundConversationForSession(params: {
  channel?: string;
  accountId?: string;
  sessionKey: string;
}): Promise<boolean> {
  if (!params.channel) {
    return false;
  }
  const accountId = normalizeOptionalLowercaseString(params.accountId) ?? "default";
  const { listSessionBindingsBySessionAsync } = await import("./dispatch-acp-manager.runtime.js");
  const bindings = await listSessionBindingsBySessionAsync(params.sessionKey);
  return bindings.some(
    (binding) =>
      normalizeOptionalLowercaseString(binding.conversation.channel) === params.channel &&
      (normalizeOptionalLowercaseString(binding.conversation.accountId) || "default") ===
        accountId &&
      Boolean(normalizeOptionalString(binding.conversation.conversationId)),
  );
}

export type AcpRoutedSendGuard = {
  beforeDeliver: () => Promise<void>;
  acpBindingAuthority?: AcpConversationBindingAuthority;
};

/**
 * Re-checks revocation at the transport handoff, so queued, delayed, or retried
 * sends cannot outlive the binding. Returns the routed-send options: the final
 * pre-send guard plus the binding authority durable recovery re-checks.
 */
export function guardAcpTransportHandoff(
  dispatcher: ReplyDispatcher,
  isRevoked: AcpBoundDeliveryRevocation | undefined,
): (() => Promise<AcpRoutedSendGuard>) | undefined {
  if (!isRevoked) {
    return undefined;
  }
  dispatcher.appendBeforeDeliver?.(async (payload) => ((await isRevoked()) ? null : payload));
  const beforeDeliver = async () => {
    if (await isRevoked()) {
      throw new PlatformMessageNotDispatchedError("ACP conversation binding was revoked", {
        cause: undefined,
        retryable: false,
      });
    }
  };
  return async () => {
    const acpBindingAuthority = await isRevoked.authority;
    return { beforeDeliver, ...(acpBindingAuthority ? { acpBindingAuthority } : {}) };
  };
}
