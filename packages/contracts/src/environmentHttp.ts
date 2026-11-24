import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import {
  AuthAccessTokenResult,
  AuthBrowserSessionRequest,
  AuthBrowserSessionResult,
  AuthCreatePairingCredentialInput,
  AuthMcpApprovalDecisionRequest,
  AuthMcpApprovalDetails,
  AuthMcpApprovalError,
  AuthMcpApprovalRedirect,
  AuthMcpAuthorizationRequest,
  AuthMcpAuthorizationServerMetadata,
  AuthMcpClientRegistration,
  AuthMcpProtectedResourceMetadata,
  AuthMcpRegisteredClient,
  AuthMcpRegistrationError,
  AuthMcpTokenError,
  AuthMcpTokenRequest,
  AuthMcpTokenResult,
  AuthPairingCredentialResult,
  AuthRevokeClientSessionInput,
  AuthRevokePairingLinkInput,
  AuthApproveConnectDeviceInput,
  AuthApproveConnectDeviceResult,
  AuthRevokeConnectDeviceInput,
  AuthRevokeConnectDeviceResult,
  AuthEnvironmentScope,
  AuthTokenExchangeRequest,
  AuthSessionState,
  AuthWebSocketTicketParams,
  AuthWebSocketTicketResult,
  ServerAuthSessionMethod,
} from "./auth.ts";
import {
  ExecutionEnvironmentDescriptor,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
} from "./environment.ts";
import {
  DpopFailureReason,
  AuthSessionId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  CloudSpeechApiKey,
  CloudSpeechError,
  CloudSpeechKeys,
  CloudSpeechModelId,
  CloudSpeechModels,
  CloudSpeechProvider,
  EnvironmentSpeechAccelerationRequest,
  EnvironmentSpeechModelLinkRequest,
  EnvironmentSpeechModelRequest,
  EnvironmentSpeechModels,
  EnvironmentSpeechModelUnloadTimeoutRequest,
  EnvironmentSpeechPostProcessingRequest,
  EnvironmentSpeechPostProcessingResult,
  EnvironmentSpeechStatus,
  EnvironmentSpeechTranscriptionResult,
} from "./speech.ts";
import { SecretReference } from "./secretReference.ts";
import {
  OrchestrationV2ShellHttpSnapshot,
  OrchestrationV2ShellResumable,
  OrchestrationV2ThreadBoundedSnapshot,
  OrchestrationV2ThreadDetailSnapshot,
  OrchestrationV2ThreadHistoryPage,
  OrchestrationV2ThreadTranscript,
} from "./orchestrationV2.ts";
import { Project, ProjectMutation, ProjectSnapshot } from "./project.ts";
import {
  PullRequestDiffInput,
  PullRequestDiffResult,
  PullRequestOperationError,
  PullRequestUnavailableError,
} from "./pullRequest.ts";
import {
  RelayCloudEnvironmentHealthRequest,
  RelayCloudMintCredentialRequest,
  RelayEnvironmentConfigRequest,
  RelayEnvironmentHealthResponse,
  RelayEnvironmentLinkProof,
  RelayEnvironmentMintResponse,
  RelayLinkProofRequest,
} from "./relay.ts";

const OptionalBearerHeaders = Schema.Struct({
  authorization: Schema.optionalKey(Schema.String),
  dpop: Schema.optionalKey(Schema.String),
});

const OrchestrationProtocolHeaders = Schema.Struct({
  authorization: Schema.optionalKey(Schema.String),
  dpop: Schema.optionalKey(Schema.String),
  [ORCHESTRATION_PROTOCOL_HEADER]: Schema.Literal(ORCHESTRATION_PROTOCOL_VERSION_TEXT),
});

const OptionalDpopProofHeaders = Schema.Struct({
  dpop: Schema.optionalKey(Schema.String),
});

export const EnvironmentRequestInvalidReason = Schema.Literals([
  "invalid_scope",
  "scope_not_granted",
  "invalid_command",
  "invalid_history_cursor",
  "thread_transcript_too_large",
  "invalid_audio",
  "speech_unavailable",
  "speech_busy",
]);
export type EnvironmentRequestInvalidReason = typeof EnvironmentRequestInvalidReason.Type;

export const EnvironmentAuthInvalidReason = Schema.Literals([
  "missing_credential",
  "invalid_credential",
]);
export type EnvironmentAuthInvalidReason = typeof EnvironmentAuthInvalidReason.Type;

export const EnvironmentOperationForbiddenReason = Schema.Literals([
  "current_session_revoke_not_allowed",
]);
export type EnvironmentOperationForbiddenReason = typeof EnvironmentOperationForbiddenReason.Type;

export const EnvironmentInternalErrorReason = Schema.Literals([
  "bootstrap_validation_failed",
  "browser_session_issuance_failed",
  "browser_session_cookie_failed",
  "access_token_issuance_failed",
  "websocket_ticket_issuance_failed",
  "pairing_credential_issuance_failed",
  "pairing_links_load_failed",
  "pairing_link_revoke_failed",
  "client_sessions_load_failed",
  "client_session_revoke_failed",
  "connect_device_approve_failed",
  "connect_device_revoke_failed",
  "project_snapshot_failed",
  "project_mutation_failed",
  "orchestration_snapshot_failed",
  "orchestration_thread_snapshot_failed",
  "orchestration_thread_bounded_snapshot_failed",
  "orchestration_thread_history_failed",
  "internal_error",
]);
export type EnvironmentInternalErrorReason = typeof EnvironmentInternalErrorReason.Type;

export class EnvironmentRequestInvalidError extends Schema.TaggedError<EnvironmentRequestInvalidError>()(
  "EnvironmentRequestInvalidError",
  {
    code: Schema.Literal("invalid_request"),
    reason: EnvironmentRequestInvalidReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 400 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentRequestInvalidError)(this, { status: 400 });
  }

  override get message(): string {
    return `The environment rejected the request (${this.reason}).`;
  }
}

export class EnvironmentAuthInvalidError extends Schema.TaggedError<EnvironmentAuthInvalidError>()(
  "EnvironmentAuthInvalidError",
  {
    code: Schema.Literal("auth_invalid"),
    reason: EnvironmentAuthInvalidReason,
    dpopFailureReason: Schema.optionalKey(DpopFailureReason),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 401 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentAuthInvalidError)(this, { status: 401 });
  }

  override get message(): string {
    return `The environment rejected this client's credentials (${this.reason}).`;
  }
}

export class EnvironmentScopeRequiredError extends Schema.TaggedError<EnvironmentScopeRequiredError>()(
  "EnvironmentScopeRequiredError",
  {
    code: Schema.Literal("insufficient_scope"),
    requiredScope: AuthEnvironmentScope,
    requiredPermission: Schema.optionalKey(Schema.String),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 403 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentScopeRequiredError)(this, { status: 403 });
  }

  override get message(): string {
    return `This request needs the ${this.requiredPermission ?? this.requiredScope} scope, which this client does not have.`;
  }
}

/** The host requires approval for this T3 Connect device and nobody has given it yet. */
export class EnvironmentConnectApprovalPendingError extends Schema.TaggedError<EnvironmentConnectApprovalPendingError>()(
  "EnvironmentConnectApprovalPendingError",
  {
    code: Schema.Literal("connect_approval_pending"),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 403 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentConnectApprovalPendingError)(this, {
      status: 403,
    });
  }

  override get message(): string {
    return "This device is waiting for approval on the host.";
  }
}

export class EnvironmentOperationForbiddenError extends Schema.TaggedError<EnvironmentOperationForbiddenError>()(
  "EnvironmentOperationForbiddenError",
  {
    code: Schema.Literal("operation_forbidden"),
    reason: EnvironmentOperationForbiddenReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 403 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentOperationForbiddenError)(this, { status: 403 });
  }

  override get message(): string {
    return `The environment refused this operation (${this.reason}).`;
  }
}

export class EnvironmentInternalError extends Schema.TaggedError<EnvironmentInternalError>()(
  "EnvironmentInternalError",
  {
    code: Schema.Literal("internal_error"),
    reason: EnvironmentInternalErrorReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 500 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentInternalError)(this, { status: 500 });
  }

  override get message(): string {
    return `The environment failed to answer this request (${this.reason}).`;
  }
}

export const EnvironmentResourceNotFoundReason = Schema.Literals(["thread_not_found"]);
export type EnvironmentResourceNotFoundReason = typeof EnvironmentResourceNotFoundReason.Type;

export class EnvironmentResourceNotFoundError extends Schema.TaggedError<EnvironmentResourceNotFoundError>()(
  "EnvironmentResourceNotFoundError",
  {
    code: Schema.Literal("not_found"),
    reason: EnvironmentResourceNotFoundReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 404 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentResourceNotFoundError)(this, { status: 404 });
  }

  override get message(): string {
    return `The environment could not find what this request named (${this.reason}).`;
  }
}

export const EnvironmentHttpCommonError = Schema.Union([
  EnvironmentRequestInvalidError,
  EnvironmentAuthInvalidError,
  EnvironmentScopeRequiredError,
  EnvironmentOperationForbiddenError,
  EnvironmentResourceNotFoundError,
  EnvironmentInternalError,
  EnvironmentConnectApprovalPendingError,
]);
export type EnvironmentHttpCommonError = typeof EnvironmentHttpCommonError.Type;

const EnvironmentAuthenticationErrors = [
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
] as const;

export class EnvironmentHttpBadRequestError extends Schema.TaggedError<EnvironmentHttpBadRequestError>()(
  "EnvironmentHttpBadRequestError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpBadRequestError)(this, { status: 400 });
  }
}

export class EnvironmentHttpUnauthorizedError extends Schema.TaggedError<EnvironmentHttpUnauthorizedError>()(
  "EnvironmentHttpUnauthorizedError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 401 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpUnauthorizedError)(this, { status: 401 });
  }
}

export class EnvironmentHttpForbiddenError extends Schema.TaggedError<EnvironmentHttpForbiddenError>()(
  "EnvironmentHttpForbiddenError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 403 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpForbiddenError)(this, { status: 403 });
  }
}

export class EnvironmentHttpInternalServerError extends Schema.TaggedError<EnvironmentHttpInternalServerError>()(
  "EnvironmentHttpInternalServerError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 500 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpInternalServerError)(this, { status: 500 });
  }
}

export class EnvironmentHttpConflictError extends Schema.TaggedError<EnvironmentHttpConflictError>()(
  "EnvironmentHttpConflictError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpConflictError)(this, { status: 409 });
  }
}

export class EnvironmentCloudEndpointUnavailableError extends Schema.TaggedError<EnvironmentCloudEndpointUnavailableError>()(
  "EnvironmentCloudEndpointUnavailableError",
  {
    message: Schema.String,
    endpointRuntimeStatus: Schema.Unknown,
  },
  { httpApiStatus: 503 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentCloudEndpointUnavailableError)(this, {
      status: 503,
    });
  }
}
const EnvironmentSessionCreationErrors = [
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
] as const;
const EnvironmentTokenExchangeErrors = [
  EnvironmentRequestInvalidError,
  EnvironmentAuthInvalidError,
  EnvironmentConnectApprovalPendingError,
  EnvironmentInternalError,
] as const;
const EnvironmentScopedOperationErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentInternalError,
] as const;
const EnvironmentPairingCredentialErrors = [
  EnvironmentRequestInvalidError,
  // The managed policy does not allow remote clients.
  EnvironmentHttpForbiddenError,
  ...EnvironmentScopedOperationErrors,
] as const;
const EnvironmentSessionRevokeErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentOperationForbiddenError,
  EnvironmentInternalError,
] as const;
const EnvironmentProjectSnapshotErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentInternalError,
] as const;
const EnvironmentOrchestrationSnapshotErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentInternalError,
] as const;
const EnvironmentOrchestrationThreadSnapshotErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentResourceNotFoundError,
  EnvironmentInternalError,
] as const;
const EnvironmentProjectMutationErrors = [
  EnvironmentRequestInvalidError,
  EnvironmentScopeRequiredError,
  EnvironmentInternalError,
] as const;

export interface EnvironmentSessionPrincipalShape {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly method: ServerAuthSessionMethod;
  readonly scopes: ReadonlySet<AuthEnvironmentScope>;
  readonly proofKeyThumbprint?: string;
  readonly expiresAt?: DateTime.DateTime;
}

export class EnvironmentAuthenticatedPrincipal extends Context.Service<
  EnvironmentAuthenticatedPrincipal,
  EnvironmentSessionPrincipalShape
>()("@t3tools/contracts/environmentHttp/EnvironmentAuthenticatedPrincipal") {}

export class EnvironmentAuthenticatedAuth extends HttpApiMiddleware.Service<
  EnvironmentAuthenticatedAuth,
  { provides: EnvironmentAuthenticatedPrincipal }
>()("EnvironmentAuthenticatedAuth", {
  error: EnvironmentAuthenticationErrors,
}) {}

const EnvironmentHttpCloudErrors = [
  EnvironmentHttpBadRequestError,
  EnvironmentHttpUnauthorizedError,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpConflictError,
  EnvironmentHttpInternalServerError,
  EnvironmentScopeRequiredError,
] as const;

export const EnvironmentCloudRelayConfigResult = Schema.Struct({
  ok: Schema.Boolean,
  endpointRuntimeStatus: Schema.Unknown,
});
export type EnvironmentCloudRelayConfigResult = typeof EnvironmentCloudRelayConfigResult.Type;

export const EnvironmentConnectReachabilityCause = Schema.Literals([
  "not_linked",
  "connector_not_running",
  "connector_not_ready",
  "edge_unreachable",
  "no_connector",
  "origin_unreachable",
  "dns_failed",
  "timeout",
  "unexpected_response",
]);
export type EnvironmentConnectReachabilityCause = typeof EnvironmentConnectReachabilityCause.Type;

/** Whether other devices can reach this environment through its T3 Connect tunnel. */
export const EnvironmentConnectReachability = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("reachable"),
    checkedAt: Schema.String,
    /** Null when cloudflared did not report a count. */
    readyConnections: Schema.NullOr(Schema.Int),
    protocol: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    status: Schema.Literal("unreachable"),
    checkedAt: Schema.String,
    cause: EnvironmentConnectReachabilityCause,
    reason: Schema.String,
    hint: Schema.NullOr(Schema.String),
    fix: Schema.String,
  }),
]);
export type EnvironmentConnectReachability = typeof EnvironmentConnectReachability.Type;

/** "Tunnel connected · 4 connections · QUIC" for a healthy check. */
export function formatConnectReachable(
  result: Extract<EnvironmentConnectReachability, { status: "reachable" }>,
): string {
  const count = result.readyConnections;
  return [
    "Tunnel connected",
    ...(count === null ? [] : [`${count} connection${count === 1 ? "" : "s"}`]),
    ...(result.protocol ? [result.protocol.toUpperCase()] : []),
  ].join(" · ");
}

/**
 * Sections of docs/user/t3-connect-troubleshooting.md. Each is the GitHub anchor of a
 * heading there; the test fails when a heading is renamed without updating this list.
 */
export const T3_CONNECT_TROUBLESHOOTING_SECTIONS = [
  "the-hosts-tunnel-is-offline",
  "port-7844-is-blocked-on-the-host",
  "the-tunnel-works-but-t3-code-does-not-answer",
  "the-t3-connect-address-does-not-resolve-or-answer",
  "this-device-cant-reach-t3-connect",
  "sign-in-account-or-link-problems",
  "the-clock-is-off",
  "the-host-runs-an-older-t3-code",
  "t3-connect-returned-an-error",
] as const;
export type T3ConnectTroubleshootingSection = (typeof T3_CONNECT_TROUBLESHOOTING_SECTIONS)[number];

/** Clients, the CLI, and server logs link here as "More info". */
export function t3ConnectTroubleshootingUrl(section: T3ConnectTroubleshootingSection): string {
  return `https://github.com/pingdotgg/t3code/blob/main/docs/user/t3-connect-troubleshooting.md#${section}`;
}

const REACHABILITY_SECTION = {
  not_linked: "sign-in-account-or-link-problems",
  connector_not_running: "the-hosts-tunnel-is-offline",
  connector_not_ready: "the-hosts-tunnel-is-offline",
  no_connector: "the-hosts-tunnel-is-offline",
  edge_unreachable: "port-7844-is-blocked-on-the-host",
  origin_unreachable: "the-tunnel-works-but-t3-code-does-not-answer",
  unexpected_response: "the-tunnel-works-but-t3-code-does-not-answer",
  dns_failed: "the-t3-connect-address-does-not-resolve-or-answer",
  timeout: "the-t3-connect-address-does-not-resolve-or-answer",
} satisfies Record<EnvironmentConnectReachabilityCause, T3ConnectTroubleshootingSection>;

export function connectReachabilityHelpUrl(cause: EnvironmentConnectReachabilityCause): string {
  return t3ConnectTroubleshootingUrl(REACHABILITY_SECTION[cause]);
}

export const EnvironmentCloudLinkStateResult = Schema.Struct({
  linked: Schema.Boolean,
  cloudUserId: Schema.NullOr(Schema.String),
  relayUrl: Schema.NullOr(Schema.String),
  relayIssuer: Schema.NullOr(Schema.String),
  managedTunnelActive: Schema.optional(Schema.Boolean),
  publishAgentActivity: Schema.Boolean,
  holdWebhooksWhileOffline: Schema.optional(Schema.Boolean),
  linkRevoked: Schema.optional(Schema.Boolean),
  /** The latest check the server ran on its own, absent until one finishes. */
  reachability: Schema.optional(EnvironmentConnectReachability),
  /** The tunnel's public hostname, once cloudflared has connected. Older servers omit it. */
  tunnelHostname: Schema.optional(Schema.String),
  /** Whether this is the desktop app's own session, which may link from where it is. */
  linkableHere: Schema.optional(Schema.Boolean),
});
export type EnvironmentCloudLinkStateResult = typeof EnvironmentCloudLinkStateResult.Type;

export const EnvironmentCloudPreferencesRequest = Schema.Struct({
  publishAgentActivity: Schema.Boolean,
  holdWebhooksWhileOffline: Schema.optional(Schema.Boolean),
});
export type EnvironmentCloudPreferencesRequest = typeof EnvironmentCloudPreferencesRequest.Type;

export const AuthPairingLinkRevokeResult = Schema.Struct({
  revoked: Schema.Boolean,
});
export type AuthPairingLinkRevokeResult = typeof AuthPairingLinkRevokeResult.Type;

export const AuthClientSessionRevokeResult = Schema.Struct({
  revoked: Schema.Boolean,
});
export type AuthClientSessionRevokeResult = typeof AuthClientSessionRevokeResult.Type;

export const AuthOtherClientSessionsRevokeResult = Schema.Struct({
  revokedCount: Schema.Number,
});
export type AuthOtherClientSessionsRevokeResult = typeof AuthOtherClientSessionsRevokeResult.Type;

class EnvironmentMetadataHttpApi extends HttpApiGroup.make("metadata").add(
  HttpApiEndpoint.get("descriptor", "/.well-known/t3/environment", {
    success: ExecutionEnvironmentDescriptor,
  }),
) {}

class EnvironmentAuthHttpApi extends HttpApiGroup.make("auth")
  .add(
    HttpApiEndpoint.get("session", "/api/auth/session", {
      headers: OptionalBearerHeaders,
      success: AuthSessionState,
      error: [EnvironmentInternalError],
    }),
  )
  .add(
    HttpApiEndpoint.post("browserSession", "/api/auth/browser-session", {
      payload: AuthBrowserSessionRequest,
      success: AuthBrowserSessionResult,
      error: EnvironmentSessionCreationErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("token", "/oauth/token", {
      headers: OptionalDpopProofHeaders,
      payload: AuthTokenExchangeRequest,
      success: AuthAccessTokenResult,
      error: EnvironmentTokenExchangeErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("webSocketTicket", "/api/auth/websocket-ticket", {
      headers: OptionalBearerHeaders,
      success: AuthWebSocketTicketResult,
      error: [EnvironmentInternalError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("webSocketTicketFor", "/api/auth/websocket-ticket/:use", {
      headers: OptionalBearerHeaders,
      params: AuthWebSocketTicketParams,
      success: AuthWebSocketTicketResult,
      error: [EnvironmentInternalError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("pairingCredential", "/api/auth/pairing-token", {
      headers: OptionalBearerHeaders,
      payload: AuthCreatePairingCredentialInput,
      success: AuthPairingCredentialResult,
      error: EnvironmentPairingCredentialErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("revokePairingLink", "/api/auth/pairing-links/revoke", {
      headers: OptionalBearerHeaders,
      payload: AuthRevokePairingLinkInput,
      success: AuthPairingLinkRevokeResult,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("revokeClient", "/api/auth/clients/revoke", {
      headers: OptionalBearerHeaders,
      payload: AuthRevokeClientSessionInput,
      success: AuthClientSessionRevokeResult,
      error: EnvironmentSessionRevokeErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("approveConnectDevice", "/api/auth/connect-devices/approve", {
      headers: OptionalBearerHeaders,
      payload: AuthApproveConnectDeviceInput,
      success: AuthApproveConnectDeviceResult,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("revokeConnectDevice", "/api/auth/connect-devices/revoke", {
      headers: OptionalBearerHeaders,
      payload: AuthRevokeConnectDeviceInput,
      success: AuthRevokeConnectDeviceResult,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("revokeOtherClients", "/api/auth/clients/revoke-others", {
      headers: OptionalBearerHeaders,
      success: AuthOtherClientSessionsRevokeResult,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

class EnvironmentMcpOAuthHttpApi extends HttpApiGroup.make("mcpOAuth")
  .add(
    HttpApiEndpoint.get("protectedResource", "/.well-known/oauth-protected-resource", {
      success: AuthMcpProtectedResourceMetadata,
    }),
  )
  .add(
    HttpApiEndpoint.get("mcpProtectedResource", "/.well-known/oauth-protected-resource/mcp", {
      success: AuthMcpProtectedResourceMetadata,
    }),
  )
  .add(
    HttpApiEndpoint.get("authorizationServer", "/.well-known/oauth-authorization-server", {
      success: AuthMcpAuthorizationServerMetadata,
    }),
  )
  .add(
    HttpApiEndpoint.post("register", "/oauth/mcp/register", {
      payload: AuthMcpClientRegistration,
      success: AuthMcpRegisteredClient,
      error: AuthMcpRegistrationError,
    }),
  )
  .add(HttpApiEndpoint.get("authorize", "/oauth/mcp/authorize"))
  .add(
    HttpApiEndpoint.post("approval", "/oauth/mcp/approval", {
      // The hosted app sends the owner's T3 Connect credential; the environment's own page uses its cookie.
      headers: OptionalBearerHeaders,
      payload: AuthMcpAuthorizationRequest,
      success: [AuthMcpApprovalDetails, AuthMcpApprovalRedirect],
      error: AuthMcpApprovalError,
    }),
  )
  .add(
    HttpApiEndpoint.post("decision", "/oauth/mcp/decision", {
      // The hosted app sends the owner's T3 Connect credential; the environment's own page uses its cookie.
      headers: OptionalBearerHeaders,
      payload: AuthMcpApprovalDecisionRequest,
      success: AuthMcpApprovalRedirect,
      error: AuthMcpApprovalError,
    }),
  )
  .add(
    HttpApiEndpoint.post("token", "/oauth/mcp/token", {
      payload: AuthMcpTokenRequest,
      success: AuthMcpTokenResult,
      error: AuthMcpTokenError,
    }),
  ) {}

const EnvironmentOrchestrationThreadSnapshotParams = Schema.Struct({
  threadId: ThreadId,
});

export const EnvironmentOrchestrationShellSnapshotQuery = Schema.Struct({
  omitIdleSubagents: Schema.optionalKey(Schema.String),
  omitOlderSettled: Schema.optionalKey(Schema.String),
  /**
   * The cursor of rows the client holds, loaded with the same omissions. The server answers
   * `resumable` instead of a snapshot when the socket can replay from it.
   */
  resumeFrom: Schema.optionalKey(Schema.String),
});

export const EnvironmentOrchestrationThreadBoundedSnapshotQuery = Schema.Struct({
  deferWork: Schema.optionalKey(Schema.String),
  compactTurnItems: Schema.optionalKey(Schema.String),
  dedupeBodies: Schema.optionalKey(Schema.String),
  compactIds: Schema.optionalKey(Schema.String),
});

export const EnvironmentOrchestrationThreadHistoryQuery = Schema.Struct({
  cursor: TrimmedNonEmptyString,
  throughEntryId: Schema.optional(TrimmedNonEmptyString),
  view: Schema.optional(Schema.Literals(["conversation", "activity", "work"])),
  deferWork: Schema.optionalKey(Schema.String),
  compactIds: Schema.optionalKey(Schema.String),
});

const EnvironmentOrchestrationThreadHistoryErrors = [
  EnvironmentRequestInvalidError,
  EnvironmentScopeRequiredError,
  EnvironmentResourceNotFoundError,
  EnvironmentInternalError,
] as const;

class EnvironmentOrchestrationHttpApi extends HttpApiGroup.make("orchestration")
  .add(
    HttpApiEndpoint.get("shellSnapshot", "/api/orchestration/shell", {
      headers: OrchestrationProtocolHeaders,
      query: EnvironmentOrchestrationShellSnapshotQuery,
      success: [OrchestrationV2ShellHttpSnapshot, OrchestrationV2ShellResumable],
      error: EnvironmentOrchestrationSnapshotErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("threadSnapshot", "/api/orchestration/threads/:threadId", {
      headers: OrchestrationProtocolHeaders,
      params: EnvironmentOrchestrationThreadSnapshotParams,
      success: OrchestrationV2ThreadDetailSnapshot,
      error: EnvironmentOrchestrationThreadSnapshotErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("threadTranscript", "/api/orchestration/threads/:threadId/transcript", {
      headers: OrchestrationProtocolHeaders,
      params: EnvironmentOrchestrationThreadSnapshotParams,
      success: OrchestrationV2ThreadTranscript,
      error: [EnvironmentRequestInvalidError, ...EnvironmentOrchestrationThreadSnapshotErrors],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("threadBoundedSnapshot", "/api/orchestration/threads/:threadId/bounded", {
      headers: OrchestrationProtocolHeaders,
      params: EnvironmentOrchestrationThreadSnapshotParams,
      query: EnvironmentOrchestrationThreadBoundedSnapshotQuery,
      success: OrchestrationV2ThreadBoundedSnapshot,
      error: EnvironmentOrchestrationThreadSnapshotErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("threadHistoryPage", "/api/orchestration/threads/:threadId/history", {
      headers: OrchestrationProtocolHeaders,
      params: EnvironmentOrchestrationThreadSnapshotParams,
      query: EnvironmentOrchestrationThreadHistoryQuery,
      success: OrchestrationV2ThreadHistoryPage,
      error: EnvironmentOrchestrationThreadHistoryErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

class EnvironmentProjectsHttpApi extends HttpApiGroup.make("projects")
  .add(
    HttpApiEndpoint.get("snapshot", "/api/projects", {
      headers: OptionalBearerHeaders,
      success: ProjectSnapshot,
      error: EnvironmentProjectSnapshotErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("mutate", "/api/projects/mutate", {
      headers: OptionalBearerHeaders,
      payload: ProjectMutation,
      success: Project,
      error: EnvironmentProjectMutationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

class EnvironmentPullRequestsHttpApi extends HttpApiGroup.make("pullRequests").add(
  HttpApiEndpoint.post("diff", "/api/pull-requests/diff", {
    headers: OptionalBearerHeaders,
    payload: PullRequestDiffInput,
    success: PullRequestDiffResult,
    error: [
      PullRequestUnavailableError,
      PullRequestOperationError,
      EnvironmentAuthInvalidError,
      EnvironmentScopeRequiredError,
      EnvironmentInternalError,
    ],
  }).middleware(EnvironmentAuthenticatedAuth),
) {}

export class EnvironmentVoiceBodyLimit extends HttpApiMiddleware.Service<EnvironmentVoiceBodyLimit>()(
  "EnvironmentVoiceBodyLimit",
  { error: EnvironmentRequestInvalidError },
) {}

export class EnvironmentVoiceHttpApi extends HttpApiGroup.make("voice")
  .add(
    HttpApiEndpoint.get("cloudKeys", "/api/voice/cloud/keys", {
      headers: OptionalBearerHeaders,
      success: CloudSpeechKeys,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("setCloudKey", "/api/voice/cloud/:provider/key", {
      headers: OptionalBearerHeaders,
      params: Schema.Struct({ provider: CloudSpeechProvider }),
      payload: Schema.Struct({
        key: Schema.NullOr(
          Schema.Union([Schema.RedactedFromValue(CloudSpeechApiKey), SecretReference]),
        ),
      }),
      success: HttpApiSchema.NoContent,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    // Public catalog; carries no credential and no audio.
    HttpApiEndpoint.get("cloudModels", "/api/voice/cloud/openrouter/models", {
      headers: OptionalBearerHeaders,
      success: CloudSpeechModels,
      error: [...EnvironmentScopedOperationErrors, CloudSpeechError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("transcribeCloud", "/api/voice/cloud/:provider/transcribe", {
      headers: OptionalBearerHeaders,
      params: Schema.Struct({ provider: CloudSpeechProvider }),
      query: Schema.Struct({ model: Schema.optionalKey(CloudSpeechModelId) }),
      payload: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
      success: EnvironmentSpeechTranscriptionResult,
      error: [
        ...EnvironmentScopedOperationErrors,
        EnvironmentRequestInvalidError,
        CloudSpeechError,
      ],
    })
      .middleware(EnvironmentVoiceBodyLimit)
      .middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("status", "/api/voice/status", {
      headers: OptionalBearerHeaders,
      success: EnvironmentSpeechStatus,
      error: [...EnvironmentScopedOperationErrors, EnvironmentRequestInvalidError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("prepareModel", "/api/voice/models/prepare", {
      headers: OptionalBearerHeaders,
      success: Schema.Void,
      error: [...EnvironmentScopedOperationErrors, EnvironmentRequestInvalidError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("models", "/api/voice/models", {
      headers: OptionalBearerHeaders,
      query: { benchmarks: Schema.optionalKey(Schema.Literal("1")) },
      success: EnvironmentSpeechModels,
      error: [...EnvironmentScopedOperationErrors, EnvironmentRequestInvalidError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("downloadModel", "/api/voice/models/download", {
      headers: OptionalBearerHeaders,
      payload: EnvironmentSpeechModelRequest,
      success: EnvironmentSpeechModels,
      error: [...EnvironmentScopedOperationErrors, EnvironmentRequestInvalidError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("selectModel", "/api/voice/models/select", {
      headers: OptionalBearerHeaders,
      payload: EnvironmentSpeechModelRequest,
      success: EnvironmentSpeechModels,
      error: [...EnvironmentScopedOperationErrors, EnvironmentRequestInvalidError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("cancelModelDownload", "/api/voice/models/cancel", {
      headers: OptionalBearerHeaders,
      payload: EnvironmentSpeechModelRequest,
      success: EnvironmentSpeechModels,
      error: [...EnvironmentScopedOperationErrors, EnvironmentRequestInvalidError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("removeModel", "/api/voice/models/remove", {
      headers: OptionalBearerHeaders,
      payload: EnvironmentSpeechModelRequest,
      success: EnvironmentSpeechModels,
      error: [...EnvironmentScopedOperationErrors, EnvironmentRequestInvalidError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("linkModels", "/api/voice/models/link", {
      headers: OptionalBearerHeaders,
      payload: EnvironmentSpeechModelLinkRequest,
      success: EnvironmentSpeechModels,
      error: [...EnvironmentScopedOperationErrors, EnvironmentRequestInvalidError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("updateAcceleration", "/api/voice/acceleration", {
      headers: OptionalBearerHeaders,
      payload: EnvironmentSpeechAccelerationRequest,
      success: EnvironmentSpeechStatus,
      error: [...EnvironmentScopedOperationErrors, EnvironmentRequestInvalidError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("updateModelUnloadTimeout", "/api/voice/model-unload-timeout", {
      headers: OptionalBearerHeaders,
      payload: EnvironmentSpeechModelUnloadTimeoutRequest,
      success: EnvironmentSpeechStatus,
      error: [...EnvironmentScopedOperationErrors, EnvironmentRequestInvalidError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("transcribe", "/api/voice/transcribe", {
      headers: OptionalBearerHeaders,
      payload: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
      success: EnvironmentSpeechTranscriptionResult,
      error: [...EnvironmentScopedOperationErrors, EnvironmentRequestInvalidError],
    })
      .middleware(EnvironmentVoiceBodyLimit)
      .middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("postProcess", "/api/voice/post-process", {
      headers: OptionalBearerHeaders,
      payload: EnvironmentSpeechPostProcessingRequest,
      success: EnvironmentSpeechPostProcessingResult,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

class EnvironmentConnectHttpApi extends HttpApiGroup.make("connect")
  .add(
    HttpApiEndpoint.post("linkProof", "/api/connect/link-proof", {
      headers: OptionalBearerHeaders,
      payload: RelayLinkProofRequest,
      success: RelayEnvironmentLinkProof,
      error: EnvironmentHttpCloudErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("relayConfig", "/api/connect/relay-config", {
      headers: OptionalBearerHeaders,
      payload: RelayEnvironmentConfigRequest,
      success: EnvironmentCloudRelayConfigResult,
      error: [...EnvironmentHttpCloudErrors, EnvironmentCloudEndpointUnavailableError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("linkState", "/api/connect/link-state", {
      headers: OptionalBearerHeaders,
      success: EnvironmentCloudLinkStateResult,
      error: EnvironmentHttpCloudErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("checkReachability", "/api/connect/reachability", {
      headers: OptionalBearerHeaders,
      success: EnvironmentConnectReachability,
      error: EnvironmentHttpCloudErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("unlink", "/api/connect/unlink", {
      headers: OptionalBearerHeaders,
      success: EnvironmentCloudRelayConfigResult,
      error: EnvironmentHttpCloudErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("preferences", "/api/connect/preferences", {
      headers: OptionalBearerHeaders,
      payload: EnvironmentCloudPreferencesRequest,
      success: EnvironmentCloudLinkStateResult,
      error: EnvironmentHttpCloudErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("health", "/api/t3-connect/health", {
      payload: RelayCloudEnvironmentHealthRequest,
      success: RelayEnvironmentHealthResponse,
      error: EnvironmentHttpCloudErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("t3MintCredential", "/api/t3-connect/mint-credential", {
      payload: RelayCloudMintCredentialRequest,
      success: RelayEnvironmentMintResponse,
      error: EnvironmentHttpCloudErrors,
    }),
  ) {}

// Path tokens and optional body signatures authenticate webhooks; read raw bytes to verify signatures.
const WebhookParams = Schema.Struct({
  hookId: TrimmedNonEmptyString,
  token: TrimmedNonEmptyString,
});
const WebhookAccepted = Schema.Struct({ deliveryId: TrimmedNonEmptyString }).pipe(
  HttpApiSchema.status(202),
);
const webhookEndpoint = {
  params: WebhookParams,
  success: WebhookAccepted,
} as const;
const WEBHOOK_PATH = "/api/hooks/:hookId/:token";

class EnvironmentWebhooksHttpApi extends HttpApiGroup.make("webhooks")
  .add(HttpApiEndpoint.post("webhookPost", WEBHOOK_PATH, webhookEndpoint))
  .add(HttpApiEndpoint.put("webhookPut", WEBHOOK_PATH, webhookEndpoint))
  .add(HttpApiEndpoint.patch("webhookPatch", WEBHOOK_PATH, webhookEndpoint))
  .add(HttpApiEndpoint.get("webhookGet", WEBHOOK_PATH, webhookEndpoint)) {}

const CompanionIdentifier = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const CompanionName = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const CompanionCode = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
const CompanionInfo = Schema.Record(
  TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  Schema.String.check(Schema.isMaxLength(512)),
).check(Schema.isMaxProperties(16));
const CompanionDeviceToken = Schema.Struct({
  authorization: Schema.optionalKey(Schema.String),
});
const CompanionDeviceParams = Schema.Struct({ deviceId: CompanionIdentifier });
const CompanionSuccess = Schema.Struct({ ok: Schema.Literal(true) });
const CompanionProblem = Schema.Struct({ error: Schema.String });
const CompanionProblems = [400, 401, 403, 404, 409, 413, 415, 422, 429].map((status) =>
  CompanionProblem.pipe(HttpApiSchema.status(status)),
);
const CompanionAdminErrors = [...EnvironmentScopedOperationErrors, ...CompanionProblems] as const;

export const COMPANION_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const COMPANION_MAX_IMAGE_BASE64_LENGTH = 4 * Math.ceil(COMPANION_MAX_IMAGE_BYTES / 3);

export const CompanionRenameInput = Schema.Struct({ name: CompanionName });
export const CompanionEnrollInput = Schema.Struct({
  code: CompanionCode,
  name: CompanionName,
  info: CompanionInfo,
});
export const CompanionPollInput = Schema.Struct({
  name: CompanionName,
  info: CompanionInfo,
  watchRecordingId: Schema.optionalKey(CompanionIdentifier),
  watchTaskId: Schema.optionalKey(CompanionIdentifier),
  recordingReceiptV1: Schema.optionalKey(Schema.Literal(true)),
});
export const CompanionCheckInput = Schema.Struct({
  name: Schema.optionalKey(CompanionName),
  info: CompanionInfo,
});
export const CompanionTransferReadInput = Schema.Struct({ id: CompanionIdentifier });
const CompanionFileSha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const CompanionFileName = TrimmedNonEmptyString.check(Schema.isMaxLength(240));
const CompanionFileBase64 = Schema.String.check(
  Schema.isMaxLength(COMPANION_MAX_IMAGE_BASE64_LENGTH),
  Schema.isBase64(),
);
export const CompanionCaptureKind = Schema.Literals(["window", "display"]);
export const COMPANION_MAX_RECORDING_SECONDS = 30;
export const CompanionCaptureMetadata = Schema.Struct({
  capturedAt: Schema.String.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
  ),
  label: TrimmedNonEmptyString.check(
    Schema.isMaxLength(120),
    Schema.isPattern(/^[^\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]+$/u),
  ),
});
export const CompanionWindowsInstallation = Schema.Union([
  Schema.Struct({
    attempt: Schema.Int.check(Schema.isGreaterThan(0)),
    status: Schema.Literals(["opened", "canceled", "unverified"]),
  }),
  Schema.Struct({
    attempt: Schema.Int.check(Schema.isGreaterThan(0)),
    status: Schema.Literal("verified"),
    productCode: Schema.String.check(
      Schema.isPattern(/^\{[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}\}$/u),
    ),
    version: Schema.String.check(Schema.isMaxLength(32), Schema.isPattern(/^\d+(?:\.\d+){1,3}$/u)),
  }),
]);
export const CompanionResultInput = Schema.Struct({
  captureScope: Schema.optionalKey(CompanionCaptureKind),
  capture: Schema.optionalKey(CompanionCaptureMetadata),
  id: CompanionIdentifier,
  status: Schema.Literals(["running", "done", "failed"]),
  closeState: Schema.optionalKey(Schema.Literals(["waiting-for-exit", "exited"])),
  windowsInstallation: Schema.optionalKey(
    Schema.Struct({
      sha256: CompanionFileSha256,
      result: CompanionWindowsInstallation,
    }),
  ),
  message: Schema.String.check(Schema.isMaxLength(4096)),
  file: Schema.optionalKey(
    Schema.Struct({
      name: CompanionFileName,
      sha256: CompanionFileSha256,
      data: CompanionFileBase64,
    }),
  ),
  savedFile: Schema.optionalKey(
    Schema.Struct({
      path: TrimmedNonEmptyString.check(Schema.isMaxLength(2048)),
      sha256: CompanionFileSha256,
    }),
  ),
  recordingBase64: Schema.optionalKey(
    Schema.NonEmptyString.check(
      Schema.isMaxLength(COMPANION_MAX_IMAGE_BASE64_LENGTH),
      Schema.isBase64(),
    ),
  ),
  imageBase64: Schema.optionalKey(
    Schema.NonEmptyString.check(
      Schema.isMaxLength(COMPANION_MAX_IMAGE_BASE64_LENGTH),
      Schema.isBase64(),
    ),
  ),
});
export const CompanionUnbindInput = Schema.Struct({});

export const AndroidCaptureAction = Schema.Literals(["screenshot", "record-screen"]);
export const AndroidCaptureFailure = Schema.Literals([
  "denied",
  "locked",
  "revoked",
  "canceled",
  "failed",
]);
export const AndroidCaptureJob = Schema.Struct({
  progressReceipts: Schema.optionalKey(Schema.Literal(true)),
  id: CompanionIdentifier,
  threadId: ThreadId,
  action: AndroidCaptureAction,
  durationSeconds: Schema.Int.check(
    Schema.isBetween({
      minimum: 1,
      maximum: COMPANION_MAX_RECORDING_SECONDS,
    }),
  ),
  expiresAt: Schema.Number,
  expiresInMs: Schema.optionalKey(Schema.Number),
});
export const AndroidCaptureInput = Schema.Union([
  Schema.TaggedStruct("listen", {
    name: CompanionName,
    delivery: Schema.optionalKey(
      Schema.Literals(["background-ready", "background", "unavailable"]),
    ),
  }),
  Schema.TaggedStruct("progress", {
    id: CompanionIdentifier,
    stage: Schema.Literals(["received", "recording"]),
  }),
  Schema.TaggedStruct("approve", { id: CompanionIdentifier }),
  Schema.TaggedStruct("status", { id: CompanionIdentifier }),
  Schema.TaggedStruct("reject", { id: CompanionIdentifier, reason: AndroidCaptureFailure }),
  Schema.TaggedStruct("complete", { id: CompanionIdentifier, media: CompanionFileBase64 }),
]);
export const AndroidCaptureReply = Schema.Union([
  Schema.TaggedStruct("pending", {
    job: Schema.NullOr(AndroidCaptureJob),
    backgroundReady: Schema.optionalKey(Schema.Literal(true)),
  }),
  Schema.TaggedStruct("active", { job: AndroidCaptureJob }),
  Schema.TaggedStruct("inactive", {}),
  Schema.TaggedStruct("accepted", {}),
]);

export const CompanionDevice = Schema.Struct({
  deviceId: CompanionIdentifier,
  name: CompanionName,
  info: CompanionInfo,
  lastSeen: Schema.String,
  detailsUpdatedAt: Schema.optionalKey(Schema.String),
  online: Schema.Boolean,
  recentTasks: Schema.Array(
    Schema.Struct({
      id: CompanionIdentifier,
      threadId: Schema.optionalKey(ThreadId),
      action: Schema.String,
      status: Schema.Literals(["queued", "running", "done", "failed", "canceled"]),
      updatedAt: Schema.String,
      savedPath: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(2048))),
    }),
  ).check(Schema.isMaxLength(10)),
});
export type CompanionDevice = typeof CompanionDevice.Type;

class EnvironmentCompanionsHttpApi extends HttpApiGroup.make("companions")
  .add(
    HttpApiEndpoint.post("androidCapture", "/api/companions/android-capture", {
      headers: OptionalBearerHeaders,
      payload: AndroidCaptureInput,
      success: AndroidCaptureReply,
      error: CompanionAdminErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("pair", "/api/companions/pair", {
      headers: OptionalBearerHeaders,
      success: Schema.Struct({ code: CompanionCode, expiresAt: Schema.String }),
      error: CompanionAdminErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("list", "/api/companions", {
      headers: OptionalBearerHeaders,
      success: Schema.Struct({ devices: Schema.Array(CompanionDevice) }),
      error: CompanionAdminErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("rename", "/api/companions/:deviceId/rename", {
      params: CompanionDeviceParams,
      headers: OptionalBearerHeaders,
      payload: CompanionRenameInput,
      success: CompanionSuccess,
      error: CompanionAdminErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("revoke", "/api/companions/:deviceId/revoke", {
      params: CompanionDeviceParams,
      headers: OptionalBearerHeaders,
      success: CompanionSuccess,
      error: CompanionAdminErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("enroll", "/api/companions/enroll", {
      payload: CompanionEnrollInput,
      success: Schema.Struct({ deviceId: CompanionIdentifier, token: Schema.String }),
      error: [...CompanionProblems, EnvironmentInternalError],
    }),
  )
  .add(
    HttpApiEndpoint.post("poll", "/api/companions/poll", {
      headers: CompanionDeviceToken,
      payload: CompanionPollInput,
      success: Schema.Struct({
        name: CompanionName,
        jobActive: Schema.optionalKey(Schema.Boolean),
        recordingReceiptState: Schema.optionalKey(Schema.Literals(["ready", "reported", "closed"])),
        stopRequested: Schema.optionalKey(Schema.Boolean),
        job: Schema.NullOr(
          Schema.Struct({
            id: CompanionIdentifier,
            action: Schema.String,
            threadId: Schema.String,
            params: Schema.Record(Schema.String, Schema.Unknown),
          }),
        ),
      }),
      error: [...CompanionProblems, EnvironmentInternalError],
    }),
  )
  .add(
    HttpApiEndpoint.post("checkDevice", "/api/companions/check", {
      headers: CompanionDeviceToken,
      payload: CompanionCheckInput,
      success: Schema.Struct({ name: CompanionName, detailsUpdatedAt: Schema.String }),
      error: [...CompanionProblems, EnvironmentInternalError],
    }),
  )
  .add(
    HttpApiEndpoint.post("readTransfer", "/api/companions/read-transfer", {
      headers: CompanionDeviceToken,
      payload: CompanionTransferReadInput,
      success: Schema.Struct({
        name: CompanionFileName,
        sha256: CompanionFileSha256,
        data: CompanionFileBase64,
      }),
      error: [...CompanionProblems, EnvironmentInternalError],
    }),
  )
  .add(
    HttpApiEndpoint.post("result", "/api/companions/result", {
      headers: CompanionDeviceToken,
      payload: CompanionResultInput,
      success: CompanionSuccess,
      error: [...CompanionProblems, EnvironmentInternalError],
    }),
  )
  .add(
    HttpApiEndpoint.post("unbind", "/api/companions/revoke", {
      headers: CompanionDeviceToken,
      payload: CompanionUnbindInput,
      success: CompanionSuccess,
      error: [...CompanionProblems, EnvironmentInternalError],
    }),
  ) {}

const LinuxDeviceDiagnostic = Schema.Union([
  Schema.Struct({ check: Schema.Literal("system_version"), kernelVersion: Schema.String }),
  Schema.Struct({ check: Schema.Literal("available_space"), availableBytes: Schema.Number }),
  Schema.Struct({ check: Schema.Literal("uptime"), uptimeSeconds: Schema.Number }),
]);

export const LinuxSshDevice = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  sftpAliases: Schema.Array(TrimmedNonEmptyString),
  diagnosticAliases: Schema.Array(TrimmedNonEmptyString),
  active: Schema.NullOr(Schema.Literals(["sftp-send", "sftp-receive", "ssh-diagnostics"])),
  waiting: Schema.Number,
  lastDiagnostic: Schema.optionalKey(
    Schema.Struct({
      result: LinuxDeviceDiagnostic,
      checkedAt: Schema.String,
    }),
  ),
});
export type LinuxSshDevice = typeof LinuxSshDevice.Type;

class EnvironmentLinuxDevicesHttpApi extends HttpApiGroup.make("linuxDevices").add(
  HttpApiEndpoint.get("list", "/api/linux-devices", {
    headers: OptionalBearerHeaders,
    success: Schema.Struct({ devices: Schema.Array(LinuxSshDevice) }),
    error: EnvironmentScopedOperationErrors,
  }).middleware(EnvironmentAuthenticatedAuth),
) {}

export class EnvironmentHttpApi extends HttpApi.make("environment")
  .add(EnvironmentMetadataHttpApi)
  .add(EnvironmentAuthHttpApi)
  .add(EnvironmentMcpOAuthHttpApi)
  .add(EnvironmentOrchestrationHttpApi)
  .add(EnvironmentPullRequestsHttpApi)
  .add(EnvironmentProjectsHttpApi)
  .add(EnvironmentVoiceHttpApi)
  .add(EnvironmentConnectHttpApi)
  .add(EnvironmentCompanionsHttpApi)
  .add(EnvironmentLinuxDevicesHttpApi)
  .add(EnvironmentWebhooksHttpApi) {}
