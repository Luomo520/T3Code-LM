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
import { Play, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useAssetUrlRefresh } from "../../assets/assetUrls";
import { usePreparedConnection } from "../../state/session";
import { Button } from "../ui/button";
import { MediaVideoPlayer } from "../media/MediaVideoPlayer";

export function CompanionRecordingPlayer(props: {
  readonly environmentId: EnvironmentId;
  readonly recording: CompanionRecording;
}) {
  const connection = usePreparedConnection(props.environmentId);
  const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const refresh = useAssetUrlRefresh(props.environmentId, props.recording.resource);
  const playback = useRef<AbortController | null>(null);
  const [playing, setPlaying] = useState(false);
  const [mp4, setMp4] = useState<string | null>(null);
  const [frame, setFrame] = useState<CompanionRecordingFrame | null>(null);
  const [failure, setFailure] = useState<CompanionRecordingFailure | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 关闭工具详情时取消读取并释放录像缓冲区。
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
      fetch: (url, init) =>
        fetch(url, { ...init, cache: "no-store", referrerPolicy: "no-referrer" }),
      onFrame: setFrame,
    }).then((error) => {
      if (!controller.signal.aborted) stop(error);
    });
  };

  return (
    <div className="space-y-1.5 font-sans">
      <p>{props.recording.caption}</p>
      <Button
        size="sm"
        variant="outline"
        onClick={(event) => {
          event.stopPropagation();
          toggle();
        }}
      >
        {playing ? <Square aria-hidden="true" /> : <Play aria-hidden="true" />}
        {playing ? "停止播放" : "播放录屏"}
      </Button>
      {playing && !frame && !mp4 ? (
        <p role="status" className="text-muted-foreground">
          正在读取录像…
        </p>
      ) : null}
      {mp4 ? (
        <MediaVideoPlayer
          src={mp4}
          label={props.recording.accessibilityLabel}
          autoPlay
          videoClassName="max-h-80 max-w-full"
        />
      ) : null}
      {frame ? (
        <img
          className="max-h-80 max-w-full rounded-md object-contain"
          src={frame.uri}
          width={frame.width}
          height={frame.height}
          alt={props.recording.accessibilityLabel}
          draggable={false}
          onError={() => stop("unavailable")}
        />
      ) : null}
      {failure ? (
        <p role="status" className="text-destructive">
          {companionRecordingFailureText[failure]}
        </p>
      ) : null}
    </div>
  );
}
