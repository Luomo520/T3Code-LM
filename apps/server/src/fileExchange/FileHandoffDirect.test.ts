import { AuthSessionId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  allowsDirectHandoff,
  beginDirectHandoff,
  closeDirectHandoff,
  registerDirectHandoffClient,
  signalDirectHandoff,
} from "./FileHandoffDirect.ts";

const peer = { id: "12345678-1234-1234-1234-123456789012", threadId: ThreadId.make("thread") };
const prefix = "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n";
const privateCandidate = "a=candidate:1 1 udp 2122260223 192.168.1.24 56532 typ host";
const publicCandidate = "a=candidate:2 1 udp 2122260222 198.51.100.5 56534 typ host";
const relayCandidate = "a=candidate:3 1 udp 2122260221 192.168.1.25 56536 typ relay";

describe("文件交接直连信令", () => {
  it("仅允许当前已鉴权连接的原生 Windows 与 Android 端点", () => {
    const desktop = { sessionId: AuthSessionId.make("windows"), connected: true };
    const android = { sessionId: AuthSessionId.make("android"), connected: true };
    const web = { sessionId: AuthSessionId.make("web"), connected: true };
    const closeDesktop = registerDirectHandoffClient(desktop.sessionId, "desktop", "Windows");
    const closeAndroid = registerDirectHandoffClient(android.sessionId, "mobile", "Android");
    expect(registerDirectHandoffClient(web.sessionId, "web", "Windows")).toBeUndefined();
    try {
      expect(allowsDirectHandoff(desktop, android)).toBe(true);
      expect(allowsDirectHandoff(android, desktop)).toBe(true);
      expect(allowsDirectHandoff(android, web)).toBe(false);
    } finally {
      closeDesktop?.();
      closeAndroid?.();
    }
    expect(allowsDirectHandoff(desktop, android)).toBe(false);
  });

  it("由接收端开始，只向对端发送局域网 UDP 地址", () => {
    const key = "test-offer";
    beginDirectHandoff(key, 1000);
    try {
      const sdp = `${prefix}${privateCandidate}\r\n${publicCandidate}\r\n${relayCandidate}\r\n`;
      const directOffer = { ...peer, _tag: "directOffer" as const, sdp };
      const requestStatus = { ...peer, _tag: "directStatus" as const };
      expect(signalDirectHandoff(key, directOffer, true, 1001)).toEqual({
        _tag: "direct",
        state: "active",
      });
      expect(signalDirectHandoff(key, requestStatus, true, 1001)).not.toHaveProperty("offer");

      signalDirectHandoff(key, directOffer, false, 1002);
      const publishedSdp = `${prefix}${privateCandidate}\r\n`;
      expect(signalDirectHandoff(key, requestStatus, true, 1003)).toHaveProperty(
        "offer",
        publishedSdp,
      );
      expect(signalDirectHandoff(key, requestStatus, false, 1003)).not.toHaveProperty("offer");
      const answer = { ...peer, _tag: "directAnswer" as const, sdp };
      signalDirectHandoff(key, answer, false, 1004);
      expect(signalDirectHandoff(key, requestStatus, false, 1004)).not.toHaveProperty("answer");
      signalDirectHandoff(key, answer, true, 1005);
      expect(signalDirectHandoff(key, requestStatus, false, 1006)).toHaveProperty(
        "answer",
        publishedSdp,
      );
      signalDirectHandoff(key, { ...peer, _tag: "directAbandon" }, false, 1007);
      expect(signalDirectHandoff(key, requestStatus, true, 1008)).toHaveProperty("state", "closed");
    } finally {
      closeDirectHandoff(key);
    }
  });

  it("仅有公网候选地址时结束协商，超时请求也不能恢复协商", () => {
    const key = "test-public-candidate";
    beginDirectHandoff(key, 1000);
    try {
      const signal = { ...peer, _tag: "directOffer" as const, sdp: prefix + publicCandidate };
      expect(signalDirectHandoff(key, signal, false, 1001)).toHaveProperty("state", "closed");
      beginDirectHandoff(key, 2000);
      expect(signalDirectHandoff(key, signal, false, 47_000)).toHaveProperty("state", "closed");
    } finally {
      closeDirectHandoff(key);
    }
  });
});
