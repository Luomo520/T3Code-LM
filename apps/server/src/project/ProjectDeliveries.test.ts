import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { makeProjectDeliveryListing } from "./ProjectDeliveries.ts";

describe("项目交付", () => {
  it.effect("读取项目和对话的交付目录，保留发布说明并按客户端平台优先展示", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const folder = yield* fs.makeTempDirectoryScoped();
      const root = paths.join(folder, "registered");
      const direct = paths.join(root, "交付", "产品", "1.2.3-1");
      const thread = paths.join(root, "对话-task", "交付", "工具", "v2.0.0");
      const outside = paths.join(folder, "outside");
      for (const directory of [direct, thread, outside, paths.join(root, "tmp")]) {
        yield* fs.makeDirectory(directory, { recursive: true });
      }
      yield* fs.writeFileString(
        paths.join(direct, "README.md"),
        "# 版本说明\n本地构建日期为 2026-11-22",
      );
      yield* fs.writeFileString(paths.join(direct, "产品-windows.exe"), "fake exe");
      yield* fs.writeFileString(paths.join(thread, "工具-测试.apk"), "fake apk");
      yield* fs.writeFileString(paths.join(root, "tmp", "产品-缓存.apk"), "not delivered");
      yield* fs.writeFileString(paths.join(outside, "outside-release.apk"), "not in project");
      yield* fs.symlink(outside, paths.join(direct, "outside"));
      yield* fs.symlink(
        paths.join(outside, "outside-release.apk"),
        paths.join(direct, "outside.apk"),
      );

      const list = yield* makeProjectDeliveryListing;
      const projects = [
        { id: ProjectId.make("project-1"), title: "示例项目", workspaceRoot: root },
      ];
      const result = yield* list({ projects, preferredPlatform: "android" });
      expect(result.incomplete).toBe(false);
      expect(result.files.map((file) => file.name)).toEqual([
        "工具-测试.apk",
        "产品-windows.exe",
        "README.md",
      ]);
      expect(result.files[0]).toMatchObject({
        relativePath: "对话-task/交付/工具/v2.0.0/工具-测试.apk",
        platform: "android",
        version: "2.0.0",
        notesPath: null,
      });
      expect(result.files[1]).toMatchObject({
        platform: "windows",
        version: "1.2.3-1",
        date: "2026-11-22",
        notesPath: "交付/产品/1.2.3-1/README.md",
      });
      const query = yield* list({ projects, query: "ＷＩＮＤＯＷＳ" });
      expect(query.files.map((file) => file.name)).toEqual(["产品-windows.exe"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("通过偏移量读取完整历史版本", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const directory = paths.join(root, "deliveries");
      yield* fs.makeDirectory(directory);
      yield* Effect.forEach(
        Array.from({ length: 42 }, (_, index) => paths.join(directory, `build-${index}.zip`)),
        (file) => fs.writeFileString(file, "test"),
        { discard: true, concurrency: 4 },
      );
      const list = yield* makeProjectDeliveryListing;
      const projects = [
        { id: ProjectId.make("project-1"), title: "测试项目", workspaceRoot: root },
      ];
      const firstPage = yield* list({ projects });
      expect(firstPage.nextOffset).not.toBeNull();
      const secondPage = yield* list({ projects, offset: firstPage.nextOffset! });
      expect(secondPage.nextOffset).toBeNull();
      expect(new Set([...firstPage.files, ...secondPage.files].map((file) => file.name)).size).toBe(
        42,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
