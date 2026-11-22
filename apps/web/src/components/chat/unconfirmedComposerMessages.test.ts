import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import type { ChatMessage } from "../../types";

const harness = vi.hoisted(() => ({
  connection: undefined as Atom.Writable<unknown> | undefined,
  messages: undefined as Atom.Atom<ReadonlyArray<ChatMessage>> | undefined,
  getDelivery: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: Atom.Atom<ReadonlyArray<ChatMessage>>) => {
    harness.messages = atom;
    return appAtomRegistry.get(atom);
  },
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../../state/threads", () => ({
  threadEnvironment: {
    getMessageDelivery: { label: "test-message-delivery", run: harness.getDelivery },
  },
}));
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  environmentConnectionAtom: () => harness.connection,
}));

import {
  confirmComposerMessageDelivery,
  forgetEchoedComposerMessages,
  mergeUnconfirmedComposerMessages,
  useUnconfirmedComposerMessages as readUnconfirmedComposerMessages,
} from "./unconfirmedComposerMessages";

const environmentId = EnvironmentId.make("test-environment");
const threadId = ThreadId.make("test-thread");

function setup(threadKey: string) {
  harness.getDelivery.mockReset();
  const connection = Atom.make<unknown>(AsyncResult.success(null)).pipe(Atom.keepAlive);
  harness.connection = connection;
  readUnconfirmedComposerMessages(threadKey);
  const message: ChatMessage = {
    id: MessageId.make(threadKey),
    role: "user",
    text: "Use the original message",
    createdAt: "2026-11-22T00:00:00.000Z",
    updatedAt: "2026-11-22T00:00:00.000Z",
    runId: null,
    streaming: false,
  };
  const resend = vi.fn(async () => AsyncResult.success(undefined));
  const completion = confirmComposerMessageDelivery({
    threadKey,
    commandId: CommandId.make(threadKey),
    environmentId,
    threadId,
    message,
    resend,
  });
  const connect = () => {
    appAtomRegistry.set(connection, AsyncResult.success([{ phase: "connected" }, Option.some({})]));
  };
  function waitForStatus(status: NonNullable<ChatMessage["delivery"]>["status"]) {
    let unsubscribe: (() => void) | undefined;
    return new Promise<void>((resolve) => {
      unsubscribe = appAtomRegistry.subscribe(harness.messages!, ([entry]) => {
        if (entry?.delivery?.status === status) resolve();
      });
    }).finally(() => unsubscribe?.());
  }
  return { message, resend, completion, connect, waitForStatus };
}

it("waits for a missing receipt before resending the original message once", async () => {
  const threadKey = "test-missing-delivery";
  const flow = setup(threadKey);
  harness.getDelivery.mockResolvedValue(AsyncResult.success({ status: "missing" }));
  expect(readUnconfirmedComposerMessages(threadKey)[0]?.delivery?.status).toBe("confirming");
  expect(harness.getDelivery).not.toHaveBeenCalled();
  const missing = flow.waitForStatus("resend");
  flow.connect();
  await missing;

  const delivery = readUnconfirmedComposerMessages(threadKey)[0]?.delivery;
  if (delivery?.status !== "resend") throw new Error("Expected a resend action");
  delivery.action();
  delivery.action();
  expect((await flow.completion)._tag).toBe("Success");
  expect(flow.resend).toHaveBeenCalledOnce();
  expect(readUnconfirmedComposerMessages(threadKey)[0]?.id).toBe(flow.message.id);
});

it("settles an older server's unavailable receipt when the original message is echoed", async () => {
  const threadKey = "test-legacy-delivery";
  const flow = setup(threadKey);
  harness.getDelivery.mockResolvedValue(AsyncResult.success({ status: "legacy-unconfirmed" }));
  const unsupported = flow.waitForStatus("legacy-unconfirmed");
  flow.connect();
  await unsupported;

  forgetEchoedComposerMessages(threadKey, new Set([flow.message.id]));
  expect((await flow.completion)._tag).toBe("Success");
  expect(readUnconfirmedComposerMessages(threadKey)).toEqual([]);
  flow.connect();
  expect(harness.getDelivery).toHaveBeenCalledOnce();
  expect(flow.resend).not.toHaveBeenCalled();
});

it("keeps original timeline order when an unconfirmed row replaces an optimistic row", () => {
  const sent: ChatMessage = {
    id: MessageId.make("sent"),
    role: "user",
    text: "Original",
    createdAt: "2026-11-22T00:00:00.000Z",
    updatedAt: "2026-11-22T00:00:00.000Z",
    runId: null,
    streaming: false,
  };
  const later = { ...sent, id: MessageId.make("later") };
  const unconfirmed = { ...sent, delivery: { status: "confirming" as const } };
  const optimistic = [sent, later];
  const retained = [unconfirmed];
  expect(mergeUnconfirmedComposerMessages(optimistic, retained, new Set())).toEqual([
    unconfirmed,
    later,
  ]);
  expect(mergeUnconfirmedComposerMessages(optimistic, retained, new Set([sent.id]))).toBe(
    optimistic,
  );
  expect(mergeUnconfirmedComposerMessages([], retained, new Set())).toBe(retained);
});
