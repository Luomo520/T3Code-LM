import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  createThreadSearchResultsAtomFamily,
  makeThreadSearchKey,
} from "@t3tools/client-runtime/state/thread-search";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "vite-plus/test";
import { paletteTargets, resolvePaletteEnvironment } from "./paletteEnvironment";

const nas = EnvironmentId.make("nas");
const pc = EnvironmentId.make("pc");
const home = { home: null, draft: null };
const match = {
  projectId: ProjectId.make("alpha"),
  threadId: ThreadId.make("message-origin"),
  source: "user" as const,
  snippet: "paired project marker",
  messageCreatedAt: null,
};

it("首页与返回搜索在两种连接顺序下都能找到另一台机器的原消息", () => {
  const search = createThreadSearchResultsAtomFamily<Error>({
    getSearchAtom: (id) => Atom.make(AsyncResult.success({ matches: id === pc ? [match] : [] })),
    labelPrefix: "palette-scope-test",
  });
  const registry = AtomRegistry.make();
  try {
    for (const ids of [
      [nas, pc],
      [pc, nas],
    ]) {
      const original = resolvePaletteEnvironment(home);
      const restored = resolvePaletteEnvironment({ ...home, thread: nas, restored: original });
      for (const scope of [original, restored]) {
        const key = makeThreadSearchKey(paletteTargets(ids, scope), match.snippet);
        expect(registry.get(search.results(key)).matches).toEqual([
          { ...match, environmentId: pc },
        ]);
      }
    }
  } finally {
    registry.dispose();
  }
});

it("单选、会话与草稿保留所属后端，离线时不会改查其他机器", () => {
  for (const scope of [
    { ...home, home: pc },
    { home: nas, draft: pc },
    { home: nas, draft: nas, thread: pc },
    { ...home, thread: nas, restored: pc },
  ]) {
    const selected = resolvePaletteEnvironment(scope);
    expect(paletteTargets([nas, pc], selected)).toEqual([pc]);
    expect(paletteTargets([nas], selected)).toEqual([]);
  }
});
