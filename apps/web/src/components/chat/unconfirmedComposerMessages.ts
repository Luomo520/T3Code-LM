import { useAtomValue } from "@effect/atom-react";
import type { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { EnvironmentRpcUnavailableError, isRpcClientError } from "@t3tools/client-runtime/rpc";
import {
  environmentConnectionAtom,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { threadEnvironment } from "../../state/threads";
import type { ChatMessage } from "../../types";

type DeliveryState = NonNullable<ChatMessage["delivery"]>;
const isEnvironmentRpcUnavailableError = Schema.is(EnvironmentRpcUnavailableError);

const unconfirmedMessagesAtom = Atom.family((_key: string) =>
  Atom.make<ReadonlyArray<ChatMessage>>([]).pipe(Atom.keepAlive),
);

export function useUnconfirmedComposerMessages(threadKey: string) {
  return useAtomValue(unconfirmedMessagesAtom(threadKey));
}

export function mergeUnconfirmedComposerMessages(
  optimistic: ReadonlyArray<ChatMessage>,
  unconfirmed: ReadonlyArray<ChatMessage>,
  echoedIds: ReadonlySet<MessageId>,
): ReadonlyArray<ChatMessage> {
  if (unconfirmed.length === 0) return optimistic;
  const unconfirmedById = new Map(
    unconfirmed
      .filter((message) => !echoedIds.has(message.id))
      .map((message) => [message.id, message]),
  );
  if (unconfirmedById.size === 0) return optimistic;
  if (optimistic.length === 0 && unconfirmedById.size === unconfirmed.length) return unconfirmed;

  const merged = optimistic.map((message) => {
    const updated = unconfirmedById.get(message.id);
    unconfirmedById.delete(message.id);
    return updated ?? message;
  });
  return [...merged, ...unconfirmedById.values()];
}

const acceptEchoed = new Map<MessageId, () => void>();

export function forgetEchoedComposerMessages(
  threadKey: string,
  echoedIds: ReadonlySet<MessageId>,
): void {
  const atom = unconfirmedMessagesAtom(threadKey);
  const messages = appAtomRegistry.get(atom);
  if (!messages.some((message) => echoedIds.has(message.id))) return;
  for (const message of messages) {
    if (echoedIds.has(message.id)) acceptEchoed.get(message.id)?.();
  }
  appAtomRegistry.set(
    atom,
    appAtomRegistry.get(atom).filter((message) => !echoedIds.has(message.id)),
  );
}

function updateUnconfirmed(
  threadKey: string,
  message: ChatMessage,
  delivery: DeliveryState | null,
): void {
  const atom = unconfirmedMessagesAtom(threadKey);
  const messages = appAtomRegistry.get(atom).filter((entry) => entry.id !== message.id);
  appAtomRegistry.set(atom, delivery === null ? messages : [...messages, { ...message, delivery }]);
}

export function isUncertainComposerDelivery(result: AtomCommandResult<unknown, unknown>): boolean {
  if (result._tag === "Success") return false;
  const error = squashAtomCommandFailure(result);
  return (
    isAtomCommandInterrupted(result) ||
    isRpcClientError(error) ||
    isEnvironmentRpcUnavailableError(error) ||
    (typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      (error._tag === "ConnectionTransientError" || error._tag === "EnvironmentNotRegisteredError"))
  );
}

export async function confirmComposerMessageDelivery(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadKey: string;
  readonly commandId: CommandId;
  readonly message: ChatMessage;
  readonly resend: () => Promise<AtomCommandResult<unknown, unknown>>;
}): Promise<AtomCommandResult<unknown, unknown>> {
  const { environmentId, threadId, threadKey, commandId, message, resend } = input;
  const connection = environmentConnectionAtom(connectionAtomRuntime, environmentId);
  const readSession = () => {
    const current = AsyncResult.getOrElse(appAtomRegistry.get(connection), () => null);
    return current?.[0].phase === "connected" ? Option.getOrNull(current[1]) : null;
  };
  return new Promise((resolve) => {
    let busy = false;
    let finished = false;
    let canResend = false;
    let lastSession: ReturnType<typeof readSession> = null;
    const finish = (result: AtomCommandResult<unknown, unknown>) => {
      if (finished) return;
      finished = true;
      unsubscribe();
      acceptEchoed.delete(message.id);
      updateUnconfirmed(
        threadKey,
        message,
        result._tag === "Success" ? { status: "accepted" } : null,
      );
      resolve(result);
    };
    const check = async (force = false) => {
      const session = readSession();
      if (finished || busy) return;
      if (session === null) {
        if (canResend) {
          canResend = false;
          updateUnconfirmed(threadKey, message, { status: "confirming" });
        }
        lastSession = null;
        return;
      }
      if (!force && session === lastSession) return;
      busy = true;
      canResend = false;
      lastSession = session;
      updateUnconfirmed(threadKey, message, { status: "confirming" });
      const receipt = await runAtomCommand(
        appAtomRegistry,
        threadEnvironment.getMessageDelivery,
        { environmentId, input: { threadId, commandId, messageId: message.id } },
        { reportFailure: false, reportDefect: false },
      );
      busy = false;
      if (finished) return;
      if (readSession() !== session) {
        void check();
        return;
      }
      if (receipt._tag === "Failure") {
        updateUnconfirmed(threadKey, message, {
          status: "confirming",
          action: () => void check(true),
        });
        return;
      }
      const delivery = receipt.value;
      if (delivery.status === "accepted") {
        finish(AsyncResult.success(delivery));
      } else if (delivery.status === "rejected") {
        finish(AsyncResult.failure(Cause.fail(new Error(delivery.message ?? "发送失败"))));
      } else if (delivery.status === "legacy-unconfirmed") {
        updateUnconfirmed(threadKey, message, {
          status: "legacy-unconfirmed",
          action: () => void check(true),
        });
      } else {
        canResend = true;
        updateUnconfirmed(threadKey, message, { status: "resend", action: () => void retry() });
      }
    };
    const retry = async () => {
      if (!canResend || busy || finished || readSession() === null) return;
      busy = true;
      canResend = false;
      updateUnconfirmed(threadKey, message, { status: "confirming" });
      const result = await resend();
      busy = false;
      if (!isUncertainComposerDelivery(result)) {
        finish(result);
        return;
      }
      void check(true);
    };
    const unsubscribe = appAtomRegistry.subscribe(connection, () => void check());
    acceptEchoed.set(message.id, () => finish(AsyncResult.success(undefined)));
    updateUnconfirmed(threadKey, message, { status: "confirming" });
    void check();
  });
}
