import { useIsFocused } from "@react-navigation/native";
import {
  type CompanionRecording,
  type CompanionRecordingFailure,
  type CompanionRecordingFrame,
  companionRecordingFailureText,
  playCompanionRecording,
} from "@t3tools/client-runtime/work-log/companion-recording";
import type { EnvironmentId } from "@t3tools/contracts";
import { fetch } from "expo/fetch";
import { Image } from "expo-image";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useAppActive } from "../../lib/appState";
import { usePreparedConnection } from "../../state/session";

interface CompanionRecordingPlayerProps {
  readonly environmentId: EnvironmentId;
  readonly recording: CompanionRecording;
}

export function CompanionRecordingPlayer(props: CompanionRecordingPlayerProps) {
  const isFocused = useIsFocused();
  const appActive = useAppActive();
  return isFocused && appActive ? <CompanionRecordingPlayback {...props} /> : null;
}

function CompanionRecordingPlayback(props: CompanionRecordingPlayerProps) {
  const connection = usePreparedConnection(props.environmentId);
  const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const playback = useRef<AbortController | null>(null);
  const [playing, setPlaying] = useState(false);
  const [frame, setFrame] = useState<CompanionRecordingFrame | null>(null);
  const [failure, setFailure] = useState<CompanionRecordingFailure | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 离开会话或进入后台时释放录像缓冲区。
  useEffect(() => () => playback.current?.abort(), []);

  const stop = (error: CompanionRecordingFailure | null = null) => {
    playback.current?.abort();
    playback.current = null;
    setPlaying(false);
    setFrame(null);
    setFailure(error);
  };

  const toggle = () => {
    if (playback.current) {
      stop();
      return;
    }
    const controller = new AbortController();
    playback.current = controller;
    setPlaying(true);
    setFailure(null);
    void playCompanionRecording({
      recording: props.recording,
      httpBaseUrl,
      signal: controller.signal,
      fetch: (url, init) => fetch(url, { ...init, headers: { "Cache-Control": "no-store" } }),
      onFrame: setFrame,
    }).then((error) => {
      if (!controller.signal.aborted) stop(error);
    });
  };

  return (
    <View className="gap-1.5 pb-1.5">
      <Button size="compact" label={playing ? "停止播放" : "播放录屏"} onPress={toggle} />
      {playing && !frame ? (
        <AppText accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
          正在读取录像…
        </AppText>
      ) : null}
      {frame ? (
        <Image
          accessible
          accessibilityLabel="Windows 主屏幕录屏"
          cachePolicy="none"
          contentFit="contain"
          source={{ uri: frame.uri }}
          style={{ width: "100%", aspectRatio: frame.width / frame.height, maxHeight: 320 }}
          onError={() => stop("unavailable")}
        />
      ) : null}
      {failure ? (
        <AppText accessibilityLiveRegion="polite" className="text-sm text-danger-foreground">
          {companionRecordingFailureText[failure]}
        </AppText>
      ) : null}
    </View>
  );
}
