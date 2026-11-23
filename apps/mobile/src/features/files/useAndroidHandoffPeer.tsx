import type {
  HandoffFrame,
  HandoffPeer,
  OpenHandoffPeer,
} from "@t3tools/client-runtime/state/fileHandoff";
import { useCallback, useEffect, useRef, useState } from "react";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

const DOCUMENT = {
  baseUrl: "https://localhost/",
  html: `<!doctype html><meta charset="utf-8"><script>
const peer = new RTCPeerConnection({ iceServers: [] });
const frames = [];
let channel, failed = false;
const events = new EventTarget();
const update = () => events.dispatchEvent(new Event('update'));
const fail = () => { failed = true; update(); };

function bind(dataChannel) {
  channel = dataChannel;
  channel.binaryType = 'arraybuffer';
  channel.onopen = update;
  channel.onclose = fail;
  channel.onerror = fail;
  channel.onmessage = ({data}) => {
    if (frames.length >= 2 || (typeof data !== 'string' && data.byteLength > 32768)) {
      fail();
      channel.close();
      return;
    }
    frames.push(typeof data === 'string' ? { text: data } : {
      binary: btoa(String.fromCharCode(...new Uint8Array(data)))
    });
    update();
  };
  update();
}
peer.ondatachannel = ({channel}) => bind(channel);
peer.onconnectionstatechange = () => { if (peer.connectionState === 'failed') fail(); };

function wait(ready, target = events, event = 'update') {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      target.removeEventListener(event, check);
      clearTimeout(timer);
    };
    function check() {
      if (ready() || failed) {
        cleanup();
        if (failed) reject(new Error('连接已中断'));
        else resolve();
      }
    }
    const timer = setTimeout(() => { cleanup(); reject(new Error('等待直连超时')); }, 8000);
    target.addEventListener(event, check);
    check();
  });
}
async function localSdp(description) {
  await peer.setLocalDescription(description);
  await wait(() => peer.iceGatheringState === 'complete', peer, 'icegatheringstatechange');
  const sdp = peer.localDescription.sdp;
  if (!sdp.includes('a=candidate:')) throw new Error('未找到局域网直连地址');
  return sdp;
}
const commands = {
  async offer() {
    bind(peer.createDataChannel('file', { ordered: true }));
    return localSdp(await peer.createOffer());
  },
  async answer(sdp) {
    await peer.setRemoteDescription({ type: 'offer', sdp });
    return localSdp(await peer.createAnswer());
  },
  finish: sdp => peer.setRemoteDescription({ type: 'answer', sdp }),
  open: () => wait(() => channel?.readyState === 'open'),
  send(frame) {
    if (channel?.readyState !== 'open') throw new Error('直连通道不可用');
    channel.send(frame.text ?? Uint8Array.from(atob(frame.binary), character => character.charCodeAt(0)));
  },
  async next() {
    await wait(() => frames.length !== 0);
    return frames.shift();
  },
  close() {
    peer.close();
  }
};
async function request(id, command, value) {
  try {
    const result = await commands[command](value);
    window.ReactNativeWebView.postMessage(JSON.stringify({ id, result }));
  } catch (error) {
    window.ReactNativeWebView.postMessage(JSON.stringify({ id, error: String(error.message) }));
  }
}
window.ReactNativeWebView.postMessage(JSON.stringify({ ready: true }));
</script>`,
};

type SerializedFrame = { text: string } | { binary: string };
type PeerMessage = {
  readonly id?: number;
  readonly ready?: boolean;
  readonly error?: string;
  readonly result?: unknown;
};

type Command = "offer" | "answer" | "finish" | "open" | "send" | "next" | "close";

function encodeFrame(frame: HandoffFrame): SerializedFrame {
  return typeof frame === "string"
    ? { text: frame }
    : { binary: btoa(String.fromCharCode(...frame)) };
}

export function useAndroidHandoffPeer(): {
  readonly makePeer: OpenHandoffPeer;
  readonly view: React.ReactNode;
} {
  const [session, setSession] = useState(0);
  const active = useRef<{ id: number; ready: boolean; signal: AbortSignal } | null>(null);
  const view = useRef<WebView<object>>(null);
  const counter = useRef(0);
  const response = useRef<{
    id: number;
    accept: (result: PeerMessage) => void;
    launch: () => void;
  } | null>(null);
  const teardown = useCallback(() => {
    response.current?.accept({ error: "直连已关闭。" });
    active.current = null;
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 组件卸载时中止 WebView 内等待中的请求。
  useEffect(() => teardown, [teardown]);
  function handleMessage(event: WebViewMessageEvent, id: number) {
    if (active.current?.id !== id) return;
    const message = JSON.parse(event.nativeEvent.data) as PeerMessage;
    if (message.ready) {
      active.current.ready = true;
      response.current?.launch();
    } else if (message.id === response.current?.id) {
      response.current?.accept(message);
    }
  }
  function call<A>(
    signal: AbortSignal,
    command: Command,
    value?: SerializedFrame | string,
  ): Promise<A> {
    signal.throwIfAborted();
    if (response.current) throw new Error("前一次直连请求尚未完成。");
    return new Promise((resolve, reject) => {
      const id = ++counter.current;
      const finish = (message: PeerMessage) => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        if (response.current?.id === id) response.current = null;
        if (message.error !== undefined) reject(new Error(message.error));
        else resolve(message.result as A);
      };
      const abort = () => finish({ error: "直连已中止。" });
      const timeout = setTimeout(() => finish({ error: "等待直连超时。" }), 9_000);
      const args = JSON.stringify([id, command, value]);
      const launch = () => view.current?.injectJavaScript(`request(...${args}); true;`);
      signal.addEventListener("abort", abort, { once: true });
      response.current = { id, accept: finish, launch };
      if (active.current?.ready) launch();
    });
  }
  const makePeer = (signal: AbortSignal): HandoffPeer => {
    teardown();
    const id = ++counter.current;
    active.current = { id, ready: false, signal };
    setSession(id);
    return {
      offer: () => call(signal, "offer"),
      answer: (sdp) => call(signal, "answer", sdp),
      finish: (sdp) => call(signal, "finish", sdp),
      open: () => call(signal, "open"),
      send: (frame) => call(signal, "send", encodeFrame(frame)),
      async next() {
        const frame = await call<SerializedFrame>(signal, "next");
        return "text" in frame
          ? frame.text
          : Uint8Array.from(atob(frame.binary), (character) => character.charCodeAt(0));
      },
      close() {
        if (active.current?.id !== id) return;
        teardown();
        setSession(0);
      },
    };
  };
  return {
    makePeer,
    view:
      session === 0 ? null : (
        <WebView<object>
          key={session}
          ref={view}
          source={DOCUMENT}
          originWhitelist={["https://localhost"]}
          onShouldStartLoadWithRequest={(request) =>
            request.url === "about:blank" || request.url === DOCUMENT.baseUrl
          }
          javaScriptEnabled
          allowFileAccess={false}
          onMessage={(event) => handleMessage(event, session)}
          onError={teardown}
          onRenderProcessGone={teardown}
          accessible={false}
          style={{ position: "absolute", width: 1, height: 1, opacity: 0 }}
        />
      ),
  };
}
