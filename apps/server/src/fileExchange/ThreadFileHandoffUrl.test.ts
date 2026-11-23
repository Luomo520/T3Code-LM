// @effect-diagnostics nodeBuiltinImport:off -- 使用 Node 类型和文件验证生产下载写入。
import * as NodeFSP from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  FileHandoffError,
  FILE_HANDOFF_ROUTE_PREFIX,
  ThreadId,
  type AuthClientSession,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import { expect, vi } from "vite-plus/test";

import { AssetSigner } from "../assets/AssetSigner.ts";
import { EnvironmentAuth, type AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  claimThreadFileHandoff,
  readFileHandoff,
  readThreadFileHandoffStatus,
  resolveFileHandoff,
  stageThreadUrlDownload,
} from "./FileHandoff.ts";
import { fetchRemoteFile } from "./RemoteFileDownload.ts";

vi.mock("./RemoteFileDownload.ts", { spy: true });

it.effect(
  "offers a URL exclusively to its recipient and fetches only after that device approves",
  () => {
    const requester = AuthSessionId.make("requester");
    const recipient = AuthSessionId.make("recipient");
    const other = AuthSessionId.make("other");
    const session = (sessionId: AuthSessionId): AuthenticatedSession => ({
      sessionId,
      subject: "owner",
      method: "bearer-access-token",
      scopes: [AuthOrchestrationOperateScope, AuthOrchestrationReadScope],
    });
    const clients = [requester, recipient, other].map((sessionId): AuthClientSession => ({
      ...session(sessionId),
      issuedAt: DateTime.makeUnsafe(0),
      expiresAt: DateTime.makeUnsafe(253402300799000),
      connected: true,
      current: false,
      lastConnectedAt: null,
      client: { label: sessionId, deviceType: "desktop" },
    }));
    const threadId = ThreadId.make("url-download-thread");
    const id = "00000000-0000-0000-0000-000000000045";
    const cancelledId = "00000000-0000-0000-0000-000000000046";
    const sourceUrl = "https://files.example.org/report.txt?language=zh";
    const sha256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    const download = vi.mocked(fetchRemoteFile);
    download.mockReset();
    download.mockRejectedValueOnce(new FileHandoffError({ message: "下载来源未返回文件。" }));
    download.mockImplementationOnce(async (_url, path) => {
      await NodeFSP.writeFile(path, "abc");
      return { sizeBytes: 3, sha256 };
    });

    return Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-23T10:00:00Z"));
      const stage = {
        id,
        threadId,
        requester,
        recipient,
        requesterAlias: "requester-alias",
        sourceOrdinal: 1,
        sourceUrl,
      };
      yield* stageThreadUrlDownload(stage);
      expect(yield* stageThreadUrlDownload(stage)).toMatchObject({
        status: "awaiting_save",
        urlDownload: true,
      });
      const inbox = { _tag: "inbox" as const };
      expect(yield* readFileHandoff(inbox, session(requester))).toEqual({
        _tag: "inbox",
        transfers: [],
      });
      expect(yield* readFileHandoff(inbox, session(other))).toEqual({
        _tag: "inbox",
        transfers: [],
      });
      expect(yield* readFileHandoff(inbox, session(recipient))).toMatchObject({
        transfers: [],
        urlDownloads: [{ id, threadId, sourceUrl }],
      });
      expect(download).not.toHaveBeenCalled();

      const approve = { _tag: "approveUrl" as const, id, threadId };
      const read = { _tag: "receive" as const, id, threadId };
      expect(yield* Effect.result(readFileHandoff(read, session(recipient)))).toMatchObject({
        _tag: "Failure",
      });
      expect(yield* Effect.result(readFileHandoff(approve, session(other)))).toMatchObject({
        _tag: "Failure",
      });
      yield* stageThreadUrlDownload({ ...stage, id: cancelledId });
      expect(
        yield* readFileHandoff({ _tag: "cancel", id: cancelledId, threadId }, session(recipient)),
      ).toEqual({
        _tag: "finished",
        disposition: "cancelled",
      });
      expect(
        yield* Effect.result(readFileHandoff({ ...approve, id: cancelledId }, session(recipient))),
      ).toMatchObject({ _tag: "Failure" });
      expect(download).not.toHaveBeenCalled();

      expect(yield* Effect.result(readFileHandoff(approve, session(recipient)))).toMatchObject({
        _tag: "Failure",
        failure: { message: "下载来源未返回文件。" },
      });
      expect(yield* readThreadFileHandoffStatus(threadId, id)).toMatchObject({
        status: "awaiting_save",
        urlFailure: "下载来源未返回文件。",
      });
      expect(yield* readFileHandoff(approve, session(recipient))).toMatchObject({
        _tag: "receive",
        sha256,
        sizeBytes: 3,
      });
      expect(yield* readThreadFileHandoffStatus(threadId, id)).not.toHaveProperty("urlFailure");
      expect(yield* readFileHandoff(inbox, session(recipient))).toMatchObject({
        transfers: [],
        urlDownloads: [{ id, sourceUrl, ready: { sizeBytes: 3, sha256 } }],
      });
      expect(yield* readFileHandoff(approve, session(recipient))).toMatchObject({
        _tag: "receive",
      });
      expect(download).toHaveBeenCalledTimes(2);
      const release = yield* readFileHandoff(read, session(recipient));
      if (release._tag !== "receive") throw new Error("Missing download link");
      const transfer = yield* resolveFileHandoff(
        release.relativeUrl.slice(FILE_HANDOFF_ROUTE_PREFIX.length + 1),
        "receive",
      );
      if (transfer === null) throw new Error("Download link was not resolved");
      expect(yield* Effect.promise(() => NodeFSP.readFile(transfer.path, "utf8"))).toBe("abc");
      expect(yield* claimThreadFileHandoff(transfer)).toBe(true);
      yield* readFileHandoff(
        {
          _tag: "confirmSaved",
          id,
          threadId,
          sizeBytes: 3,
          sha256,
          savedPath: "Download/report.txt",
        },
        session(recipient),
      );
      expect(yield* readThreadFileHandoffStatus(threadId, id)).toMatchObject({
        status: "saved",
        savedPath: "Download/report.txt",
      });
      expect(yield* readFileHandoff(inbox, session(recipient))).toEqual({
        _tag: "inbox",
        transfers: [],
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(AssetSigner)({
            sign: () => Effect.succeed("test-signature"),
            verify: () => Effect.succeed(true),
          }),
          Layer.mock(EnvironmentAuth)({ listSessions: () => Effect.succeed(clients) }),
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-url-download-test-" }),
          ServerSettingsService.layerTest(),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );
  },
);
