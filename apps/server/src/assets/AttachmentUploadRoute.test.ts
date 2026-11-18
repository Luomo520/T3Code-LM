import * as DocumentText from "../provider/DocumentText.ts";
import * as AssetSigner from "./AssetSigner.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { layerAttachmentUploadRoute } from "../http.ts";
import { issueAttachmentUploadUrl } from "./AttachmentUpload.ts";

it("streams a 51 MiB HTTP upload and returns 413 after the saved limit shrinks", async () => {
  const sizeBytes = 51 * 1024 * 1024;
  // Test-only control endpoints share the same isolated services as the real upload route.
  const controls = Layer.merge(
    HttpRouter.add(
      "GET",
      "/test/issue",
      Effect.gen(function* () {
        const issued = yield* issueAttachmentUploadUrl({
          type: "file",
          name: "http-large.zip",
          mimeType: "application/zip",
          sizeBytes,
        });
        return yield* HttpServerResponse.json(issued);
      }),
    ),
    HttpRouter.add(
      "POST",
      "/test/shrink",
      Effect.gen(function* () {
        yield* (yield* ServerSettingsService).updateSettings({ attachmentMaxFileSizeMiB: 1 });
        return HttpServerResponse.empty();
      }),
    ),
  );
  const services = Layer.merge(
    ServerSecretStore.layer,
    ServerSettingsService.layerTest({
      attachmentMaxFileSizeMiB: 51,
    }),
  );
  const layerApp = Layer.merge(controls, layerAttachmentUploadRoute).pipe(
    Layer.provideMerge(DocumentText.layer),
    Layer.provideMerge(AssetSigner.layer),
    Layer.provideMerge(services),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-upload-http-test-" })),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  const { handler: routeHandler, dispose } = HttpRouter.toWebHandler(layerApp, { disableLogger: true });
  const handler = (request: Request) => routeHandler(request, undefined);
  try {
    const issued = await handler(new Request("http://127.0.0.1/test/issue"));
    expect(issued.status).toBe(200);
    const { relativeUrl } = (await issued.json()) as { relativeUrl: string };
    const chunk = new Uint8Array(1024 * 1024).fill(7);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 51) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const uploaded = await handler(
      new Request("http://127.0.0.1" + relativeUrl, {
        method: "POST",
        headers: { "content-length": String(sizeBytes) },
        body,
        duplex: "half",
      } as RequestInit),
    );
    expect(uploaded.status).toBe(204);

    const second = await handler(new Request("http://127.0.0.1/test/issue"));
    const stale = (await second.json()) as { relativeUrl: string };
    await handler(new Request("http://127.0.0.1/test/shrink", { method: "POST" }));
    const refused = await handler(
      new Request("http://127.0.0.1" + stale.relativeUrl, {
        method: "POST",
        headers: { "content-length": String(sizeBytes) },
        body: "unused",
      }),
    );
    expect(refused.status).toBe(413);
    expect(await refused.text()).toContain("1 MiB");
  } finally {
    await dispose();
  }
});
