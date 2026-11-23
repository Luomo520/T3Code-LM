import { useIsFocused } from "@react-navigation/native";
import {
  type CompanionRecording,
  type CompanionRecordingFailure,
  type CompanionRecordingFrame,
  companionRecordingFailureText,
  isCompanionMp4,
  resolveCompanionMp4Url,
  playCompanionRecording,
} from "@t3tools/client-runtime/work-log/companion-recording";
import type { EnvironmentId } from "@t3tools/contracts";
import { fetch } from "expo/fetch";
import { Image } from "expo-image";
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";

import { MediaVideoPlayer } from "../../components/MediaVideoPlayer";
import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useAppActive } from "../../lib/appState";
import { useRefreshAssetUrl } from "../../state/assets";
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
  const refresh = useRefreshAssetUrl(props.environmentId, props.recording.resource);
  const playback = useRef<AbortController | null>(null);
  const [playing, setPlaying] = useState(false);
  const [mp4, setMp4] = useState<string | null>(null);
  const [frame, setFrame] = useState<CompanionRecordingFrame | null>(null);
  const [failure, setFailure] = useState<CompanionRecordingFailure | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 离开会话或进入后台时释放录像缓冲区。
  useEffect(() => () => playback.current?.abort(), []);

  const stop = (error: CompanionRecordingFailure | null = null) => {
    playback.current?.abort();
    playback.current = null;
    setPlaying(false);
    setFrame(null);
    setMp4(null);
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
    if (isCompanionMp4(props.recording)) {
      void resolveCompanionMp4Url(props.recording, httpBaseUrl, refresh).then((url) => {
        if (controller.signal.aborted) return;
        if (url) setMp4(url);
        else stop("unavailable");
      });
      return;
    }
    void playCompanionRecording({
      recording: props.recording,
      httpBaseUrl,
      signal: controller.signal,
      refresh,
      fetch: (url, init) => fetch(url, { ...init, headers: { "Cache-Control": "no-store" } }),
      onFrame: setFrame,
    }).then((error) => {
      if (!controller.signal.aborted) stop(error);
    });
  };

  return (
    <View className="gap-1.5 pb-1.5">
      <AppText className="text-sm">{props.recording.caption}</AppText>
      <Button size="compact" label={playing ? "停止播放" : "播放录屏"} onPress={toggle} />
      {playing && !frame && !mp4 ? (
        <AppText accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
          正在读取录像…
        </AppText>
      ) : null}
      {mp4 ? (
        <MediaVideoPlayer
          uri={mp4}
          resolvePlaybackUri={() => resolveCompanionMp4Url(props.recording, httpBaseUrl, refresh)}
          name={props.recording.accessibilityLabel}
          thumbnailKey={props.recording.resource?.taskId ?? mp4}
          expanded
          autoPlay
        />
      ) : null}
      {frame ? (
        <Image
          accessible
          accessibilityLabel={props.recording.accessibilityLabel}
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
