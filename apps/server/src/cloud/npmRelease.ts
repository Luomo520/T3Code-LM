// The RPC name is retained for old clients; fork releases come only from GitHub.
import {
  ServerNpmReleaseError,
  ServerNpmReleaseInput,
  type ServerNpmRelease,
} from "@t3tools/contracts";
import {
  cliReleaseIndexPageUrl,
  decodeForkReleaseManifest,
  forkReleaseManifestUrl,
} from "@t3tools/shared/cliRelease";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient } from "effect/http";

const MAX_RELEASE_METADATA_BYTES = 2 * 1024 * 1024;
const decodeInput = Schema.decodeUnknownEffect(ServerNpmReleaseInput);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeIndex = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      tag_name: Schema.String,
      draft: Schema.optionalKey(Schema.Boolean),
      prerelease: Schema.optionalKey(Schema.Boolean),
    }),
  ),
);
const isReleaseError = Schema.is(ServerNpmReleaseError);

export class NpmRelease extends Context.Service<
  NpmRelease,
  {
    readonly get: (
      input: ServerNpmReleaseInput,
    ) => Effect.Effect<ServerNpmRelease | null, ServerNpmReleaseError>;
  }
>()("t3/cloud/npmRelease") {}

export const make = Effect.fn("NpmRelease.make")(function* () {
  const http = yield* HttpClient.HttpClient;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const unavailable = () =>
    new ServerNpmReleaseError({ reason: "无法读取 GitHub 发布信息，请检查网络后重试。" });
  const read = Effect.fn("ForkRelease.read")(function* (url: string) {
    const response = yield* http.get(url);
    if (response.status === 404) return undefined;
    if (response.status < 200 || response.status >= 300) return yield* unavailable();
    let received = 0;
    const chunks = yield* response.stream.pipe(
      Stream.tap((chunk) => {
        received += chunk.byteLength;
        return received > MAX_RELEASE_METADATA_BYTES ? Effect.fail(unavailable()) : Effect.void;
      }),
      Stream.runCollect,
    );
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return yield* decodeJson(new TextDecoder().decode(bytes)).pipe(Effect.mapError(unavailable));
  });
  const lookupTag = Effect.fn("ForkRelease.lookupTag")(function* (tag: string) {
    const json = yield* read(forkReleaseManifestUrl(tag));
    if (json === undefined) return null;
    const manifest = decodeForkReleaseManifest(json, tag);
    if (manifest === undefined)
      return yield* new ServerNpmReleaseError({ reason: "GitHub 发布清单无效，未发起更新。" });
    // A Windows-only release must not make an unchanged Linux server appear updatable.
    const target = manifest.assets.find(
      (asset) =>
        asset.platform === (platform === "win32" ? "windows" : platform) &&
        asset.arch === arch &&
        asset.kind === (platform === "win32" ? "installer" : "server"),
    );
    return target === undefined ? null : { version: `${target.productVersion}-${target.build}` };
  });
  const lookup = Effect.fn("ForkRelease.lookup")(
    function* (spec: string) {
      if (spec !== "latest")
        return /^\d+\.\d+\.\d+-[1-9]\d*$/.test(spec) ? yield* lookupTag(`v${spec}`) : null;
      const tags = new Set<string>();
      for (let page = 1; page <= 5; page += 1) {
        const json = yield* read(cliReleaseIndexPageUrl(page));
        if (json === undefined) break;
        const releases = yield* decodeIndex(json).pipe(Effect.mapError(unavailable));
        for (const release of releases) {
          if (
            release.draft ||
            release.prerelease ||
            !/^v\d+\.\d+\.\d+-[1-9]\d*$/.test(release.tag_name)
          )
            continue;
          tags.add(release.tag_name);
        }
        if (releases.length < 100) break;
      }
      // GitHub orders releases by commit creation, not by the user's product/build sequence.
      const orderedTags = [...tags].sort((left, right) =>
        compareSemverVersions(right.slice(1), left.slice(1)),
      );
      for (const tag of orderedTags) {
        const found = yield* lookupTag(tag);
        if (found !== null) return found;
      }
      return null;
    },
    (effect) =>
      effect.pipe(
        Effect.timeout(Duration.seconds(30)),
        Effect.mapError((cause) => (isReleaseError(cause) ? cause : unavailable())),
      ),
  );
  const cache = yield* Cache.make({ capacity: 32, timeToLive: Duration.minutes(1), lookup });
  return NpmRelease.of({
    get: Effect.fn("NpmRelease.get")(function* (input) {
      const { spec } = yield* decodeInput(input).pipe(
        Effect.mapError(() => new ServerNpmReleaseError({ reason: "版本号无效。" })),
      );
      return yield* Cache.get(cache, spec);
    }),
  });
});
export const layer = Layer.effect(NpmRelease, make()).pipe(Layer.provide(FetchHttpClient.layer));
