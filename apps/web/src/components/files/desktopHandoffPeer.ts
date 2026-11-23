import type { HandoffFrame, HandoffPeer } from "@t3tools/client-runtime/state/fileHandoff";

function waitFor(
  ready: () => boolean,
  target: EventTarget,
  event: string,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  if (ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", cancel);
      target.removeEventListener(event, update);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("直连等待超时。"));
    }, 8_000);
    const cancel = () => {
      cleanup();
      reject(signal.reason);
    };
    const update = () => {
      if (!ready()) return;
      cleanup();
      resolve();
    };
    signal.addEventListener("abort", cancel, { once: true });
    target.addEventListener(event, update);
    update();
  });
}

export function openDesktopHandoffPeer(signal: AbortSignal): HandoffPeer {
  const peer = new RTCPeerConnection({ iceServers: [] });
  const events = new EventTarget();
  const frames: HandoffFrame[] = [];
  let channel: RTCDataChannel | null = null;
  let error: Error | null = null;
  function notify() {
    events.dispatchEvent(new Event("update"));
  }
  function fail() {
    error = new Error("两台设备的直连已中断。");
    notify();
  }
  function register(next: RTCDataChannel) {
    channel = next;
    channel.binaryType = "arraybuffer";
    channel.addEventListener("open", notify);
    channel.addEventListener("close", fail);
    channel.addEventListener("error", fail);
    channel.addEventListener("message", (event: MessageEvent<string | ArrayBuffer>) => {
      if (
        frames.length >= 2 ||
        (typeof event.data !== "string" && event.data.byteLength > 32 * 1024)
      ) {
        fail();
        next.close();
        return;
      }
      frames.push(typeof event.data === "string" ? event.data : new Uint8Array(event.data));
      notify();
    });
    notify();
  }
  peer.addEventListener("datachannel", (event) => register(event.channel));
  peer.addEventListener("connectionstatechange", () => {
    if (peer.connectionState === "failed") fail();
  });
  async function localSdp(description: RTCSessionDescriptionInit) {
    await peer.setLocalDescription(description);
    await waitFor(
      () => peer.iceGatheringState === "complete",
      peer,
      "icegatheringstatechange",
      signal,
    );
    const sdp = peer.localDescription?.sdp;
    if (!sdp || !sdp.includes("a=candidate:")) throw new Error("未找到局域网直连地址。");
    return sdp;
  }
  return {
    async offer() {
      register(peer.createDataChannel("file", { ordered: true }));
      return localSdp(await peer.createOffer());
    },
    async answer(sdp) {
      await peer.setRemoteDescription({ type: "offer", sdp });
      return localSdp(await peer.createAnswer());
    },
    finish: (sdp) => peer.setRemoteDescription({ type: "answer", sdp }),
    async open() {
      await waitFor(
        () => error !== null || channel?.readyState === "open",
        events,
        "update",
        signal,
      );
      if (error) throw error;
    },
    async send(frame) {
      signal.throwIfAborted();
      if (error) throw error;
      if (channel?.readyState !== "open") throw new Error("直连通道不可用。");
      if (typeof frame === "string") channel.send(frame);
      else channel.send(frame);
    },
    async next() {
      await waitFor(() => frames.length > 0 || error !== null, events, "update", signal);
      const frame = frames.shift();
      if (frame === undefined) throw error ?? new Error("直连通道不可用。");
      return frame;
    },
    close() {
      peer.close();
    },
  };
}
