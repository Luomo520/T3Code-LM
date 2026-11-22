import { useGT } from "../../i18n/I18nProvider";
import { Button } from "../../components/ui/Button";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { ConnectionTraceId } from "./ConnectionTraceId";
import {
  type EnvironmentConnectionPhase,
  type EnvironmentConnectionPresentation,
} from "@t3tools/client-runtime/connection";
import { SymbolView } from "../../components/ui/AppSymbol";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";

type ConnectionResource = "terminal" | "preview" | "review";

function noticeTitle(
  gt: ReturnType<typeof useGT>,
  phase: EnvironmentConnectionPhase,
  environmentLabel: string,
  awaitingApproval: boolean,
): string {
  if (awaitingApproval) return gt("Waiting for {environment} to approve this device", { environment: environmentLabel });
  switch (phase) {
    case "offline":
      return gt("You are offline");
    case "connecting":
      return gt("Connecting to {environment}…", { environment: environmentLabel });
    case "reconnecting":
      return gt("Reconnecting to {environment}…", { environment: environmentLabel });
    case "unsupported":
      return gt("Client not supported");
    case "error":
      return gt("{environment} is unavailable", { environment: environmentLabel });
    case "available":
      return gt("{environment} is disconnected", { environment: environmentLabel });
    case "connected":
      return "";
  }
}

function noticeDetail(
  gt: ReturnType<typeof useGT>,
  phase: EnvironmentConnectionPhase,
  resourceName: string,
  error: string | null,
  awaitingApproval: boolean,
): string {
  if (error && awaitingApproval) return error;
  if (error) {
    return phase === "reconnecting"
      ? gt("The app will keep retrying automatically. {details}", { details: error })
      : error;
  }

  switch (phase) {
    case "offline":
      return gt("Cached data remains available. {resource} will load when your connection returns.", { resource: resourceName });
    case "connecting":
    case "reconnecting":
      return gt("{resource} will load as soon as the environment is ready.", { resource: resourceName });
    case "unsupported":
      return gt("Use compatible versions of the app and server to connect.");
    case "available":
    case "error":
      return gt("Reconnect the environment to load {resource}.", { resource: resourceName });
    case "connected":
      return "";
  }
}

export function EnvironmentConnectionNotice(props: {
  readonly environmentLabel: string;
  readonly connection: EnvironmentConnectionPresentation;
  readonly resourceName: ConnectionResource;
  readonly onRetry: () => void;
}) {
  const gt = useGT();
  const resourceName = { terminal: gt("Terminal"), preview: gt("Preview"), review: gt("Review") }[props.resourceName];
  const isRetrying =
    props.connection.phase === "connecting" || props.connection.phase === "reconnecting";

  return (
    <View className="flex-1 items-center justify-center px-8">
      <View className="max-w-[320px] items-center gap-3">
        {isRetrying ? (
          <AppActivityIndicator size="small" colorClassName={"accent-icon-muted"} />
        ) : (
          <SymbolView
            name={props.connection.phase === "offline" ? "wifi.slash" : "bolt.horizontal.circle"}
            size={24}
            tintColorClassName={"accent-icon-muted"}
            type="monochrome"
          />
        )}

        <Text className="text-center text-lg font-t3-bold text-foreground">
          {noticeTitle(
            gt,
            props.connection.phase,
            props.environmentLabel,
            props.connection.awaitingApproval === true,
          )}
        </Text>
        <Text className="text-center text-sm leading-normal text-foreground-muted">
          {noticeDetail(
            gt,
            props.connection.phase,
            resourceName,
            props.connection.error,
            props.connection.awaitingApproval === true,
          )}
          {props.connection.traceId ? (
            <ConnectionTraceId traceId={props.connection.traceId} />
          ) : null}
        </Text>

        {props.connection.phase !== "offline" && props.connection.phase !== "unsupported" ? (
          <View className="mt-1">
            <Button label={gt("Retry now")} tone="secondary" onPress={props.onRetry} />
          </View>
        ) : null}
      </View>
    </View>
  );
}
