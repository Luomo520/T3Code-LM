import { useNavigation } from "@react-navigation/native";
import { projectDeliveryLabel } from "@t3tools/client-runtime/state/projects";
import {
  AuthFilesystemReadScope,
  type EnvironmentId,
  type ProjectDelivery,
  type ProjectId,
} from "@t3tools/contracts";
import { useState } from "react";
import { Platform, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { useServerConfigs } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { fileRoutePathSegments } from "../files/filePath";

export function deliveryFileRoute(
  environmentId: EnvironmentId,
  file: ProjectDelivery,
  path = file.relativePath,
) {
  return {
    environmentId: String(environmentId),
    cwd: file.workspaceRoot,
    projectName: file.projectTitle,
    path: fileRoutePathSegments(path),
  };
}

export function ProjectDeliveries(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ListActionRow
        icon="folder"
        label={open ? "收起项目交付" : "项目交付"}
        {...(props.label ? { description: props.label } : {})}
        onPress={() => setOpen(!open)}
      />
      {open && <ProjectDeliveryList {...props} />}
    </>
  );
}

function ProjectDeliveryList(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const navigation = useNavigation();
  const allowed = useEnvironmentScope(props.environmentId, AuthFilesystemReadScope);
  const supportsDeliveries =
    useServerConfigs().get(props.environmentId)?.environment.capabilities.projectDeliveries ===
    true;
  const [pages, setPages] = useState<readonly number[]>([0]);
  const [preferCurrentPlatform, setPreferCurrentPlatform] = useState(Platform.OS === "android");
  const offset = pages.at(-1) ?? 0;
  const result = useEnvironmentQuery(
    allowed && supportsDeliveries
      ? projectEnvironment.listDeliveries({
          environmentId: props.environmentId,
          input: {
            projectId: props.projectId,
            offset,
            ...(preferCurrentPlatform ? { preferredPlatform: "android" } : {}),
          },
        })
      : null,
  );
  if (!allowed || !supportsDeliveries) {
    return <Text className="px-4 py-3 text-foreground-muted">当前连接无法读取交付文件。</Text>;
  }
  if (result.error) {
    return <ListActionRow label="交付文件读取失败，点击重试" onPress={result.refresh} />;
  }
  if (!result.data) {
    return (
      <Text accessibilityLiveRegion="polite" className="px-4 py-3 text-foreground-muted">
        正在读取交付文件…
      </Text>
    );
  }
  const { files, nextOffset, incomplete } = result.data;
  return (
    <View className="border-t border-border-subtle">
      {files.length === 0 && (
        <Text className="px-4 py-3 text-foreground-muted">此项目暂无交付文件。</Text>
      )}
      {files.length > 0 && Platform.OS === "android" && (
        <ListActionRow
          label={preferCurrentPlatform ? "按全部平台日期排序" : "优先显示 Android 包"}
          onPress={() => {
            setPages([0]);
            setPreferCurrentPlatform(!preferCurrentPlatform);
          }}
        />
      )}
      {files.map((file) => (
        <View key={file.relativePath} className="border-t border-border-subtle">
          <ListActionRow
            icon="doc.text"
            label={file.name}
            description={projectDeliveryLabel(file)}
            onPress={() =>
              navigation.navigate(
                "ProjectDeliveryFile",
                deliveryFileRoute(props.environmentId, file),
              )
            }
          />
          {file.notesPath && (
            <ListActionRow
              label="版本说明"
              onPress={() =>
                navigation.navigate(
                  "ProjectDeliveryFile",
                  deliveryFileRoute(props.environmentId, file, file.notesPath!),
                )
              }
            />
          )}
        </View>
      ))}
      {offset > 0 && <ListActionRow label="上一页" onPress={() => setPages(pages.slice(0, -1))} />}
      {nextOffset !== null && (
        <ListActionRow label="下一页" onPress={() => setPages([...pages, nextOffset])} />
      )}
      {incomplete && (
        <Text className="px-4 py-3 text-foreground-muted">部分交付目录未能读取。</Text>
      )}
    </View>
  );
}
