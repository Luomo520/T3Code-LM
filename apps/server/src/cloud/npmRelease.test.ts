import { expect, it } from "@effect/vitest";
import { ServerNpmReleaseError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import * as NpmRelease from "./npmRelease.ts";

const manifest = (build: number, platform: "linux" | "windows" = "linux", arch = "x64") => ({
  schemaVersion: 1,
  product: "T3Code-LM",
  repository: "Luomo520/T3Code-LM",
  channel: "release",
  tag: `v0.1.0-${build}`,
  sourceCommit: "a".repeat(40),
  assets: (platform === "linux" ? ["server"] : ["installer", "portable"]).map((kind) => {
    const extension = kind === "server" ? "tar.gz" : kind === "installer" ? "exe" : "zip";
    const fileName = `T3Code-LM-0.1.0-${build}-${platform}-${arch}-${kind}.${extension}`;
    return {
      platform,
      arch,
      kind,
      productVersion: "0.1.0",
      build,
      fileName,
      sizeBytes: 42,
      sha256: "b".repeat(64),
      url: `https://github.com/Luomo520/T3Code-LM/releases/download/v0.1.0-${build}/${fileName}`,
    };
  }),
});
const makeService = (
  http: HttpClient.HttpClient,
  platform: NodeJS.Platform = "linux",
  arch = "x64",
) =>
  NpmRelease.make().pipe(
    Effect.provideService(HttpClient.HttpClient, http),
    Effect.provideService(HostProcess.Platform, platform),
    Effect.provideService(HostProcess.Architecture, arch),
  );
const releaseClient = (body: unknown, status = 200, urls: string[] = []) =>
  HttpClient.make((request) => {
    urls.push(request.url);
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status })),
    );
  });

it.effect("reads and caches a fork release without starting npm or another registry", () =>
  Effect.gen(function* () {
    const urls: string[] = [];
    const service = yield* makeService(releaseClient(manifest(1), 200, urls));
    expect(yield* service.get({ spec: "0.1.0-1" })).toEqual({ version: "0.1.0-1" });
    expect(yield* service.get({ spec: "0.1.0-1" })).toEqual({ version: "0.1.0-1" });
    expect(urls).toEqual([
      "https://github.com/Luomo520/T3Code-LM/releases/download/v0.1.0-1/T3Code-LM-release.json",
    ]);
    yield* TestClock.adjust("1 minute");
    expect(yield* service.get({ spec: "0.1.0-1" })).toEqual({ version: "0.1.0-1" });
    expect(urls).toHaveLength(2);
  }),
);

it.effect(
  "ignores draft, prerelease, old channels and releases only containing other platforms",
  () =>
    Effect.gen(function* () {
      const urls: string[] = [];
      const service = yield* makeService(
        HttpClient.make((request) => {
          urls.push(request.url);
          const body = request.url.includes("api.github.com")
            ? [
                { tag_name: "v0.1.0-5", draft: true },
                { tag_name: "v0.1.0-4", prerelease: true },
                { tag_name: "v0.1.0-nightly.20261030.1" },
                { tag_name: "v0.1.0-3" },
                { tag_name: "v0.1.0-2" },
              ]
            : request.url.includes("/v0.1.0-3/")
              ? manifest(3, "windows")
              : manifest(2);
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body))),
          );
        }),
      );
      expect(yield* service.get({ spec: "latest" })).toEqual({ version: "0.1.0-2" });
      expect(urls).toHaveLength(3);
      expect(urls[0]).toBe(
        "https://api.github.com/repos/Luomo520/T3Code-LM/releases?per_page=100&page=1",
      );
      expect(urls.some((url) => url.includes("npmjs"))).toBe(false);
    }),
);

it.effect("orders numeric build identifiers instead of GitHub commit creation order", () =>
  Effect.gen(function* () {
    const urls: string[] = [];
    const service = yield* makeService(
      HttpClient.make((request) => {
        urls.push(request.url);
        const body = request.url.includes("api.github.com")
          ? [{ tag_name: "v0.1.0-2" }, { tag_name: "v0.1.0-10" }]
          : manifest(10);
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body))),
        );
      }),
    );
    expect(yield* service.get({ spec: "latest" })).toEqual({ version: "0.1.0-10" });
    expect(urls[1]).toContain("/v0.1.0-10/");
  }),
);

it.effect("pages past releases without a matching Linux architecture", () =>
  Effect.gen(function* () {
    const urls: string[] = [];
    const service = yield* makeService(
      HttpClient.make((request) => {
        urls.push(request.url);
        const body =
          new URL(request.url).searchParams.get("page") === "1"
            ? Array.from({ length: 100 }, () => ({ tag_name: "not-a-fork-release" }))
            : new URL(request.url).searchParams.get("page") === "2"
              ? [{ tag_name: "v0.1.0-2" }, { tag_name: "v0.1.0-1" }]
              : request.url.includes("/v0.1.0-2/")
                ? manifest(2, "linux", "arm64")
                : manifest(1);
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body))),
        );
      }),
    );
    expect(yield* service.get({ spec: "latest" })).toEqual({ version: "0.1.0-1" });
    expect(urls).toHaveLength(4);
  }),
);

it.effect("keeps the wire-compatible nightly request unavailable without fetching", () =>
  Effect.gen(function* () {
    const service = yield* makeService(
      HttpClient.make(() => Effect.die("must not fetch another channel")),
    );
    expect(yield* service.get({ spec: "nightly" })).toBeNull();
  }),
);

it.effect("treats GitHub 404 as unpublished and never falls back to npm", () =>
  Effect.gen(function* () {
    const urls: string[] = [];
    const service = yield* makeService(releaseClient({}, 404, urls));
    expect(yield* service.get({ spec: "0.1.0-1" })).toBeNull();
    expect(urls).toHaveLength(1);
  }),
);

it.effect.each([
  { name: "foreign repository", body: { ...manifest(1), repository: "other/repo" } },
  { name: "wrong tag", body: { ...manifest(2) } },
  {
    name: "wrong SHA",
    body: { ...manifest(1), assets: [{ ...manifest(1).assets[0], sha256: "invalid" }] },
  },
  {
    name: "foreign download host",
    body: {
      ...manifest(1),
      assets: [{ ...manifest(1).assets[0], url: "https://unrelated.example/file" }],
    },
  },
  { name: "null JSON", body: null },
  { name: "empty asset list", body: { ...manifest(1), assets: [] } },
])("rejects invalid manifest: $name", ({ body }) =>
  Effect.gen(function* () {
    const service = yield* makeService(releaseClient(body));
    const result = yield* service.get({ spec: "0.1.0-1" }).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(ServerNpmReleaseError);
  }),
);

it.effect.each([403, 429, 500])("reports HTTP %s without leaking the response", (status) =>
  Effect.gen(function* () {
    const service = yield* makeService(releaseClient({ detail: "secret-response" }, status));
    const result = yield* service.get({ spec: "0.1.0-1" }).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure.message).not.toContain("secret-response");
  }),
);

it.effect("reports malformed JSON, oversized metadata and a transport failure", () =>
  Effect.gen(function* () {
    for (const body of ["not json", "x".repeat(2 * 1024 * 1024 + 1)]) {
      const service = yield* makeService(
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body))),
        ),
      );
      expect(Result.isFailure(yield* service.get({ spec: "latest" }).pipe(Effect.result))).toBe(
        true,
      );
    }
    const service = yield* makeService(
      HttpClient.make((request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request }),
          }),
        ),
      ),
    );
    expect(Result.isFailure(yield* service.get({ spec: "latest" }).pipe(Effect.result))).toBe(true);
  }),
);

it.effect("times out a response that never completes", () =>
  Effect.gen(function* () {
    const requested = yield* Deferred.make<void>();
    const service = yield* makeService(
      HttpClient.make((request) => {
        Deferred.doneUnsafe(requested, Effect.void);
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(new ReadableStream())),
        );
      }),
    );
    const pending = yield* service.get({ spec: "latest" }).pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(requested);
    yield* TestClock.adjust("30 seconds");
    expect(Result.isFailure(yield* Fiber.join(pending))).toBe(true);
  }),
);

it.effect("selects the Windows installer only with its matching portable package", () =>
  Effect.gen(function* () {
    const service = yield* makeService(releaseClient(manifest(1, "windows")), "win32");
    expect(yield* service.get({ spec: "0.1.0-1" })).toEqual({ version: "0.1.0-1" });
    const broken = manifest(1, "windows");
    broken.assets.pop();
    const missingPair = yield* makeService(releaseClient(broken), "win32");
    expect(Result.isFailure(yield* missingPair.get({ spec: "0.1.0-1" }).pipe(Effect.result))).toBe(
      true,
    );
  }),
);

it.effect.each(["--registry=https://example.com", "../other", "other-package@latest", "*", ""])(
  "rejects invalid release specs before contacting GitHub: %s",
  (spec) =>
    Effect.gen(function* () {
      const service = yield* makeService(
        HttpClient.make(() => Effect.die("invalid specs must not fetch")),
      );
      expect(Result.isFailure(yield* service.get({ spec }).pipe(Effect.result))).toBe(true);
    }),
);
