import type { MessageId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "./atom-registry";

type DeliveryStatus = "resend" | "retrying" | "legacy-unconfirmed" | "accepted";

export const threadMessageDeliveryStates = Atom.make<
  Readonly<Partial<Record<MessageId, DeliveryStatus>>>
>({}).pipe(Atom.keepAlive, Atom.withLabel("mobile:thread-outbox:delivery-states"));

export function setThreadMessageDeliveryState(
  messageId: MessageId,
  status: DeliveryStatus | undefined,
): void {
  const current = appAtomRegistry.get(threadMessageDeliveryStates);
  if (current[messageId] === status) return;
  const { [messageId]: _previous, ...remaining } = current;
  appAtomRegistry.set(
    threadMessageDeliveryStates,
    status === undefined ? remaining : { ...remaining, [messageId]: status },
  );
}

export function recheckThreadMessageDelivery(messageId: MessageId): void {
  if (appAtomRegistry.get(threadMessageDeliveryStates)[messageId] === "legacy-unconfirmed") {
    setThreadMessageDeliveryState(messageId, undefined);
  }
}

export function retryThreadMessageDelivery(messageId: MessageId): void {
  if (appAtomRegistry.get(threadMessageDeliveryStates)[messageId] === "resend") {
    setThreadMessageDeliveryState(messageId, "retrying");
  }
}
