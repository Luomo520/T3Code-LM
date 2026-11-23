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
  forkReleasePlatformsUrl,
  decodeForkReleasePlatforms,
  FORK_RELEASE_PLATFORMS_FILE,
  isForkReleaseTag,
  isForkBuildVersion,
  matchesForkReleaseChannel,
  type ForkUpdateChannel,
  type ForkReleaseAsset,
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
      assets: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({ name: Schema.String, state: Schema.optionalKey(Schema.String) }),
        ),
      ),
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

export const findServerRelease = (
  http: HttpClient.HttpClient,
  platform: NodeJS.Platform,
  arch: string,
) => {
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
  const lookupTag = Effect.fn("ForkRelease.lookupTag")(function* (
    tag: string,
    grouped: boolean,
    channel: ForkUpdateChannel | undefined,
    names?: ReadonlySet<string>,
  ) {
    const json = yield* read(grouped ? forkReleasePlatformsUrl(tag) : forkReleaseManifestUrl(tag));
    if (json === undefined) return null;
    const manifest = grouped
      ? decodeForkReleasePlatforms(json, tag)
      : decodeForkReleaseManifest(json, tag);
    if (manifest === undefined)
      return yield* new ServerNpmReleaseError({ reason: "GitHub 发布清单无效，未发起更新。" });
    if (channel === "stable" && manifest.channel === "beta") return null;
    // 仅提供 GitHub 发布页已上传且匹配当前环境的安装包。
    const target = manifest.assets.find(
      (asset) =>
        (names === undefined || names.has(asset.fileName)) &&
        asset.platform === (platform === "win32" ? "windows" : platform) &&
        asset.arch === arch &&
        asset.kind === (platform === "win32" ? "installer" : "server"),
    );
    return target ?? null;
  });
  return Effect.fn("ForkRelease.lookup")(
    function* (spec: string, groupsOnly = false) {
      const channel = spec === "beta" ? "beta" : spec === "latest" ? "stable" : undefined;
      if (channel === undefined) {
        if (!isForkBuildVersion(spec)) return null;
        if (!groupsOnly) {
          const direct = yield* lookupTag(`v${spec}`, false, undefined);
          if (direct !== null) return direct;
        }
      }
      const tags = new Map<string, { grouped: boolean; names?: ReadonlySet<string> }>();
      const product = spec.split("-")[0];
      for (let page = 1; page <= 5; page += 1) {
        const json = yield* read(cliReleaseIndexPageUrl(page));
        if (json === undefined) break;
        const releases = yield* decodeIndex(json).pipe(Effect.mapError(unavailable));
        for (const release of releases) {
          if (
            release.draft ||
            !isForkReleaseTag(release.tag_name) ||
            (channel !== undefined && !matchesForkReleaseChannel(release, channel))
          ) {
            continue;
          }
          const names =
            release.assets &&
            new Set(
              release.assets.flatMap(({ name, state }) =>
                state === undefined || state === "uploaded" ? [name] : [],
              ),
            );
          const grouped = names?.has(FORK_RELEASE_PLATFORMS_FILE) === true;
          if (
            !grouped &&
            (groupsOnly || channel === undefined || !isForkBuildVersion(release.tag_name.slice(1)))
          )
            continue;
          if (channel === undefined && release.tag_name.slice(1).split("-")[0] !== product)
            continue;
          tags.set(release.tag_name, names === undefined ? { grouped } : { grouped, names });
        }
        if (releases.length < 100) break;
      }
      const ordered = [...tags].sort(([a], [b]) => compareSemverVersions(b.slice(1), a.slice(1)));
      let best: ForkReleaseAsset | null = null;
      for (const [tag, { grouped, names }] of ordered) {
        const nextProduct = tag.slice(1).split("-")[0]!;
        if (best !== null && best.productVersion !== nextProduct) break;
        // 在历史构建页与合并页共存时，以安装包构建号确定推荐版本。
        if (!grouped && best !== null && Number(tag.split("-")[1]) <= best.build) continue;
        const found = yield* lookupTag(tag, grouped, channel, names);
        if (found === null) continue;
        if (channel === undefined) {
          if (`${found.productVersion}-${found.build}` === spec) return found;
          continue;
        }
        if (best === null || found.build > best.build) best = found;
      }
      return best;
    },
    (effect) =>
      effect.pipe(
        Effect.timeout(Duration.seconds(30)),
        Effect.mapError((cause) => (isReleaseError(cause) ? cause : unavailable())),
      ),
  );
};

export const make = Effect.fn("NpmRelease.make")(function* () {
  const find = findServerRelease(
    yield* HttpClient.HttpClient,
    yield* HostProcess.Platform,
    yield* HostProcess.Architecture,
  );
  const lookup = (spec: string) =>
    find(spec).pipe(
      Effect.map((asset) =>
        asset === null ? null : { version: `${asset.productVersion}-${asset.build}` },
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
