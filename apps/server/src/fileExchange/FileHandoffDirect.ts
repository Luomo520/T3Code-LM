import type {
  AuthClientSession,
  AuthSessionId,
  FileHandoffReply,
  FileHandoffRequest,
} from "@t3tools/contracts";

type DirectRequest = Extract<FileHandoffRequest, { _tag: `direct${string}` }>;
type DirectReply = Extract<FileHandoffReply, { _tag: "direct" }>;
type Negotiation = {
  deadline: number;
  offer?: string;
  answer?: string;
};
const negotiations = new Map<string, Negotiation>();

export function isDirectHandoffRequest(input: FileHandoffRequest): input is DirectRequest {
  return input._tag.startsWith("direct");
}

type DirectClient = "android" | "windows";
const directClients = new Map<AuthSessionId, Map<object, DirectClient>>();

export function registerDirectHandoffClient(
  id: AuthSessionId,
  surface: unknown,
  os: unknown,
): (() => void) | undefined {
  const client =
    surface === "mobile" && os === "Android"
      ? "android"
      : surface === "desktop" && os === "Windows"
        ? "windows"
        : null;
  if (!client) return undefined;
  const registered = directClients.get(id) ?? new Map<object, DirectClient>();
  const connection = {};
  registered.set(connection, client);
  directClients.set(id, registered);
  return () => {
    registered.delete(connection);
    if (registered.size === 0 && directClients.get(id) === registered) directClients.delete(id);
  };
}

export function allowsDirectHandoff(
  left: Pick<AuthClientSession, "sessionId" | "connected">,
  right: Pick<AuthClientSession, "sessionId" | "connected">,
): boolean {
  if (!left.connected || !right.connected) return false;
  const leftClients = new Set(directClients.get(left.sessionId)?.values());
  const rightClients = new Set(directClients.get(right.sessionId)?.values());
  return (
    (leftClients.has("android") && rightClients.has("windows")) ||
    (leftClients.has("windows") && rightClients.has("android"))
  );
}

export function activeDirectHandoff(key: string, now: number): Negotiation | undefined {
  const negotiation = negotiations.get(key);
  if (negotiation && negotiation.deadline <= now) {
    negotiations.delete(key);
    return undefined;
  }
  return negotiation;
}

export function beginDirectHandoff(key: string, now: number): void {
  for (const [candidate, negotiation] of negotiations) {
    if (negotiation.deadline <= now) negotiations.delete(candidate);
  }
  negotiations.set(key, { deadline: now + 45_000 });
}

export function closeDirectHandoff(key: string): void {
  negotiations.delete(key);
}

function localCandidateAddress(address: string): boolean {
  if (/^[a-z0-9-]+\.local$/i.test(address)) return true;
  if (/^(?:f[cd][\da-f]{2}|fe[89ab][\da-f]):[\da-f:]+$/i.test(address)) return true;
  const octets = address.split(".");
  if (octets.length !== 4 || octets.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) {
    return false;
  }
  const [first, second] = octets.map(Number);
  return (
    first === 10 ||
    (first === 172 && second! >= 16 && second! <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

function lanSdp(sdp: string): string | undefined {
  const lines = sdp.split(/\r?\n/);
  const media = lines.filter((line) => line.startsWith("m="));
  if (
    media.length !== 1 ||
    !/^m=application \d+ UDP\/DTLS\/SCTP webrtc-datachannel$/.test(media[0]!)
  ) {
    return undefined;
  }
  const filtered = lines.filter((line) => {
    if (!line.startsWith("a=candidate:")) return true;
    const fields = line.split(/\s+/);
    return (
      fields[2]?.toLowerCase() === "udp" &&
      fields[6] === "typ" &&
      fields[7] === "host" &&
      fields[4] !== undefined &&
      localCandidateAddress(fields[4])
    );
  });
  return filtered.some((line) => line.startsWith("a=candidate:"))
    ? filtered.join("\r\n")
    : undefined;
}

export function signalDirectHandoff(
  key: string,
  input: DirectRequest,
  outgoing: boolean,
  now: number,
): DirectReply {
  const negotiation = activeDirectHandoff(key, now);
  if (!negotiation) return { _tag: "direct", state: "closed" };
  if (input._tag === "directAbandon") {
    closeDirectHandoff(key);
    return { _tag: "direct", state: "closed" };
  }
  if (
    (input._tag === "directOffer" && !outgoing && !negotiation.offer) ||
    (input._tag === "directAnswer" && outgoing && negotiation.offer && !negotiation.answer)
  ) {
    const sdp = lanSdp(input.sdp);
    if (!sdp) {
      closeDirectHandoff(key);
      return { _tag: "direct", state: "closed" };
    }
    if (input._tag === "directOffer") negotiation.offer = sdp;
    else {
      negotiation.answer = sdp;
      // 接收者已经同意，允许持续传输至大文件落盘。
      negotiation.deadline = now + 60 * 60 * 1000;
    }
  }
  const peerSdp = outgoing
    ? negotiation.offer === undefined
      ? {}
      : { offer: negotiation.offer }
    : negotiation.answer === undefined
      ? {}
      : { answer: negotiation.answer };
  return { _tag: "direct", state: "active", ...peerSdp };
}
