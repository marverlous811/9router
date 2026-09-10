import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { WebSocketServer, WebSocket } from "ws";
import { selectCodexResponsesHeaders } from "open-sse/utils/codexHeaders.js";
import { resolveOpenAICompatibleApiType } from "open-sse/services/provider.js";
import { getSettings, validateApiKey } from "@/lib/db/index.js";
import { trackPendingRequest } from "@/lib/usageDb.js";
import { saveUsageStats } from "open-sse/handlers/chatCore/requestDetail.js";
import { extractUsage } from "open-sse/utils/usageTracking.js";
import { getProviderCredentials, markAccountUnavailable, clearAccountError } from "./auth.js";
import { getModelInfo } from "./model.js";
import { checkAndRefreshToken } from "./tokenRefresh.js";
import * as log from "../utils/logger.js";
import {
  clearCodexTurnAffinity,
  createTurnStateOwnerUnavailableError,
  getCodexTurnAffinity,
  isCodexTurnStateOwnerUnavailable,
  setCodexTurnAffinity,
} from "./codexTurnAffinity.js";

const require = createRequire(import.meta.url);
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");

const RESPONSES_PATHS = new Set(["/v1/responses", "/v1/responses/"]);
const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
const UPSTREAM_CONNECT_TIMEOUT_MS = 60_000;
const UPSTREAM_IDLE_TIMEOUT_MS = 10 * 60_000;
const DOWNSTREAM_ERROR_TYPE = "error";
const MAX_FINALIZED_RESPONSE_IDS = 1_000;

let server;

export function isResponsesWebSocketPath(url) {
  try {
    return RESPONSES_PATHS.has(new URL(url, "http://localhost").pathname);
  } catch {
    return false;
  }
}

export function buildResponsesWebSocketUrl(baseUrl) {
  const url = new URL(baseUrl);
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("Responses WebSocket upstream must use HTTP(S) or WS(S)");
  }

  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  if (!url.pathname.endsWith("/responses")) {
    url.pathname = `${url.pathname === "/" ? "" : url.pathname}/responses`;
  }
  return url.toString();
}

function splitHeaderValues(value) {
  return String(value || "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
}

export function shouldBypassProxy(targetUrl, noProxy) {
  const hostname = new URL(targetUrl).hostname.toLowerCase();
  return splitHeaderValues(noProxy).some(rule => {
    const normalized = rule.toLowerCase().replace(/^\./, "");
    return normalized === "*" || hostname === normalized || hostname.endsWith(`.${normalized}`);
  });
}

export function resolveWebSocketProxy(targetUrl, proxyOptions = {}) {
  if (proxyOptions?.vercelRelayUrl) {
    throw new Error("Relay proxy pools do not support native WebSocket Responses transport");
  }

  if (shouldBypassProxy(targetUrl, proxyOptions?.connectionNoProxy || process.env.NO_PROXY || process.env.no_proxy)) {
    return null;
  }

  const environmentProxy = new URL(targetUrl).protocol === "ws:"
    ? process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy
    : process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy;
  return proxyOptions?.connectionProxyEnabled && proxyOptions?.connectionProxyUrl
    ? proxyOptions.connectionProxyUrl
    : environmentProxy || null;
}

export function createWebSocketAgent(targetUrl, proxyOptions = {}) {
  const proxyUrl = resolveWebSocketProxy(targetUrl, proxyOptions);
  if (!proxyUrl) return null;

  try {
    if (/^socks(?:4a?|5h?):\/\//i.test(proxyUrl)) return new SocksProxyAgent(proxyUrl);
    if (/^https?:\/\//i.test(proxyUrl)) return new HttpsProxyAgent(proxyUrl);
    throw new Error("unsupported proxy scheme");
  } catch (error) {
    if (proxyOptions?.strictProxy) {
      throw new Error(`WebSocket proxy required but unavailable: ${error.message}`);
    }
    log.warn("CODEX-WS", `Ignoring unavailable WebSocket proxy: ${error.message}`);
    return null;
  }
}

function sendEvent(client, payload) {
  if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(payload));
}

function sendError(client, message, code = "upstream_error", type = "server_error") {
  sendEvent(client, {
    type: DOWNSTREAM_ERROR_TYPE,
    error: { message, type, code }
  });
}

function firstErrorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  return "Unable to establish the Responses WebSocket connection";
}

function toClientCloseCode(code) {
  const value = Number(code);
  return value >= 1000 && value <= 4999 && value !== 1004 && value !== 1005 && value !== 1006
    ? value
    : 1011;
}

export function parseResponseCreate(data) {
  let payload;
  try {
    payload = JSON.parse(data.toString());
  } catch {
    throw Object.assign(new Error("Responses WebSocket frames must be valid JSON text"), {
      status: 400,
      code: "invalid_request_error",
      type: "invalid_request_error",
    });
  }
  if (!payload || typeof payload !== "object" || payload.type !== "response.create") {
    throw Object.assign(new Error("The first Responses WebSocket frame must be response.create"), {
      status: 400,
      code: "invalid_request_error",
      type: "invalid_request_error",
    });
  }

  const model = payload.response?.model || payload.model;
  if (typeof model !== "string" || !model.trim()) {
    throw Object.assign(new Error("response.create must include a model"), {
      status: 400,
      code: "invalid_request_error",
      type: "invalid_request_error",
    });
  }
  return { payload, model };
}

function rewriteModel(payload, model) {
  const next = structuredClone(payload);
  if (next.response && typeof next.response === "object") next.response.model = model;
  else next.model = model;
  return next;
}

function providerSupportsResponsesWebSocket(provider, credentials) {
  return provider?.startsWith("openai-compatible-")
    && resolveOpenAICompatibleApiType(provider, credentials) === "responses";
}

export function buildUpstreamHeaders(credentials, rawHeaders = {}) {
  const token = credentials?.apiKey || credentials?.accessToken;
  if (!token) throw new Error("Selected Responses connection has no API key or access token");

  const turnState = rawHeaders["x-codex-turn-state"];
  const headers = {
    ...selectCodexResponsesHeaders(rawHeaders),
    ...(turnState ? { "x-codex-turn-state": String(turnState) } : {}),
    "OpenAI-Beta": "responses_websockets=2026-02-06",
    "Authorization": `Bearer ${token}`,
  };

  const accountId = credentials.providerSpecificData?.chatgptAccountId
    || credentials.providerSpecificData?.accountId;
  if (accountId) headers["ChatGPT-Account-ID"] = accountId;
  return headers;
}

export function getRequestApiKey(rawHeaders = {}) {
  const authorization = rawHeaders.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    return authorization.slice(7);
  }
  const xApiKey = rawHeaders["x-api-key"];
  return typeof xApiKey === "string" ? xApiKey : null;
}

export async function authenticateResponsesWebSocket(rawHeaders = {}) {
  const settings = await getSettings();
  const apiKey = getRequestApiKey(rawHeaders);
  if (!settings.requireApiKey) return apiKey;
  if (!apiKey) throw Object.assign(new Error("Missing API key"), { status: 401, code: "invalid_api_key", type: "authentication_error" });
  if (!await validateApiKey(apiKey)) {
    throw Object.assign(new Error("Invalid API key"), { status: 401, code: "invalid_api_key", type: "authentication_error" });
  }
  return apiKey;
}

function writeUpgradeError(socket, error) {
  if (!socket.writable) return;
  const status = Number(error?.status) || 500;
  const type = error?.type || "server_error";
  const code = error?.code || "upstream_error";
  const body = JSON.stringify({
    error: { message: firstErrorMessage(error), type, code },
  });
  socket.end([
    `HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : "Internal Server Error"}`,
    "Connection: close",
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "",
    body,
  ].join("\r\n"));
}

async function authenticateUpgrade(request, socket) {
  try {
    return await authenticateResponsesWebSocket(request.headers);
  } catch (error) {
    writeUpgradeError(socket, error);
    throw error;
  }
}

export function createUpstreamSocket(url, headers, proxyOptions) {
  const agent = createWebSocketAgent(url, proxyOptions);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers,
      agent: agent || undefined,
      handshakeTimeout: UPSTREAM_CONNECT_TIMEOUT_MS,
      perMessageDeflate: false,
      maxPayload: MAX_PAYLOAD_BYTES,
    });
    let settled = false;

    const rejectOnce = error => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners("open");
      socket.removeAllListeners("error");
      socket.removeAllListeners("unexpected-response");
      if (socket.readyState < WebSocket.CLOSING) socket.close();
      reject(error);
    };
    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      socket.removeListener("error", rejectOnce);
      socket.removeListener("unexpected-response", unexpectedResponse);
      resolve(socket);
    };
    const unexpectedResponse = (_request, response) => {
      const error = Object.assign(
        new Error(`Upstream WebSocket handshake failed with ${response.statusCode}`),
        { status: response.statusCode },
      );
      response.resume();
      rejectOnce(error);
    };

    socket.once("open", resolveOnce);
    socket.once("error", rejectOnce);
    socket.once("unexpected-response", unexpectedResponse);
  });
}

async function resolveConnection(modelName, { turnState, apiKey } = {}) {
  const modelInfo = await getModelInfo(modelName);
  if (!modelInfo.provider) throw new Error("Combos are not supported by the Responses WebSocket transport");

  const affinity = getCodexTurnAffinity({
    turnState,
    apiKey,
    provider: modelInfo.provider,
    model: modelInfo.model,
  });
  const credentials = await getProviderCredentials(
    modelInfo.provider,
    null,
    modelInfo.model,
    affinity ? {
      preferredConnectionId: affinity.connectionId,
      strictPreferredConnection: true,
    } : undefined,
  );
  if (credentials?.preferredConnectionUnavailable) {
    clearCodexTurnAffinity({ turnState, apiKey });
    throw createTurnStateOwnerUnavailableError();
  }
  if (credentials?.allRateLimited) {
    throw Object.assign(new Error(`All provider accounts are unavailable (${credentials.retryAfterHuman})`), { status: 503, retryAfter: credentials.retryAfter });
  }
  if (!credentials) throw Object.assign(new Error(`No active credentials for provider: ${modelInfo.provider}`), { status: 404 });

  const refreshedCredentials = await checkAndRefreshToken(modelInfo.provider, credentials);
  if (!providerSupportsResponsesWebSocket(modelInfo.provider, refreshedCredentials)) {
    throw Object.assign(new Error("This model is only available through the HTTP Responses transport"), { status: 400, code: "websocket_unsupported", type: "invalid_request_error" });
  }

  setCodexTurnAffinity({
    turnState,
    apiKey,
    provider: modelInfo.provider,
    model: modelInfo.model,
    connectionId: refreshedCredentials.connectionId,
  });
  return { ...modelInfo, credentials: refreshedCredentials };
}

class ResponsesWebSocketRelay {
  constructor(client, request, apiKey) {
    this.client = client;
    this.request = request;
    this.apiKey = apiKey;
    this.upstream = null;
    this.connection = null;
    this.closing = false;
    this.pendingResponses = [];
    this.responsesById = new Map();
    this.finalizedResponseIds = new Set();
    this.chain = Promise.resolve();
    this.idleTimer = null;
    this.upstreamErrorForwarded = false;
    this.accountFailureMarked = false;
    this.endpoint = new URL(request.url, "http://localhost").pathname;
  }

  start() {
    this.client.on("message", (data, isBinary) => {
      this.chain = this.chain
        .then(() => this.handleMessage(data, isBinary))
        .catch(error => this.fail(error));
    });
    this.client.on("close", () => this.closeUpstream());
    this.client.on("error", () => this.closeUpstream());
  }

  startResponse() {
    const response = { id: null, finalized: false };
    this.pendingResponses.push(response);
    trackPendingRequest(
      this.connection.model,
      this.connection.provider,
      this.connection.credentials.connectionId,
      true,
    );
    return response;
  }

  bindResponse(id) {
    if (!id || this.responsesById.has(id)) return this.responsesById.get(id) || null;
    const response = this.pendingResponses.find(item => !item.id && !item.finalized);
    if (!response) return null;
    response.id = id;
    this.responsesById.set(id, response);
    return response;
  }

  findResponse(event) {
    const id = event?.response?.id;
    if (id && this.responsesById.has(id)) return this.responsesById.get(id);
    if (id && this.finalizedResponseIds.has(id)) return null;
    if (id) return this.bindResponse(id);
    return this.pendingResponses.find(item => !item.finalized) || null;
  }

  finalizeResponse(response, { error = false, usage = null } = {}) {
    if (!response || response.finalized) return false;
    response.finalized = true;
    this.pendingResponses = this.pendingResponses.filter(item => item !== response);
    if (response.id) {
      this.responsesById.delete(response.id);
      this.finalizedResponseIds.add(response.id);
      if (this.finalizedResponseIds.size > MAX_FINALIZED_RESPONSE_IDS) {
        this.finalizedResponseIds.delete(this.finalizedResponseIds.values().next().value);
      }
    }

    trackPendingRequest(
      this.connection.model,
      this.connection.provider,
      this.connection.credentials.connectionId,
      false,
      error,
    );
    if (usage) {
      saveUsageStats({
        provider: this.connection.provider,
        model: this.connection.model,
        tokens: usage,
        connectionId: this.connection.credentials.connectionId,
        apiKey: this.apiKey,
        endpoint: this.endpoint,
        silent: true,
      });
    }
    return true;
  }

  finalizePendingResponses(error = false) {
    for (const response of [...this.pendingResponses]) {
      this.finalizeResponse(response, { error });
    }
  }

  hasPendingResponses() {
    return this.pendingResponses.some(response => !response.finalized);
  }

  refreshIdleTimer() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.closing) {
        sendError(this.client, "Upstream Responses WebSocket became idle", "upstream_websocket_liveness_timeout");
        this.client.close(1011, "Upstream WebSocket idle timeout");
      }
    }, UPSTREAM_IDLE_TIMEOUT_MS);
    this.idleTimer.unref?.();
  }

  async handleMessage(data, isBinary) {
    if (isBinary) throw Object.assign(new Error("Responses WebSocket accepts JSON text frames only"), { status: 400, code: "invalid_request_error", type: "invalid_request_error" });

    const { payload, model: requestedModel } = parseResponseCreate(data);
    if (!this.connection) {
      await this.connect(requestedModel);
    } else {
      const modelInfo = await getModelInfo(requestedModel);
      if (modelInfo.provider !== this.connection.provider || modelInfo.model !== this.connection.model) {
        throw Object.assign(new Error("A Responses WebSocket cannot switch models or accounts; open a new connection"), { status: 400, code: "websocket_model_switch", type: "invalid_request_error" });
      }
    }

    this.upstream.send(JSON.stringify(rewriteModel(payload, this.connection.model)));
    this.startResponse();
    this.refreshIdleTimer();
  }

  async connect(requestedModel) {
    this.connection = await resolveConnection(requestedModel, {
      turnState: this.request.headers["x-codex-turn-state"],
      apiKey: this.apiKey,
    });
    const baseUrl = this.connection.credentials.providerSpecificData?.baseUrl;
    if (!baseUrl) throw new Error("Responses provider has no base URL");

    const upstreamUrl = buildResponsesWebSocketUrl(baseUrl);
    const headers = buildUpstreamHeaders(this.connection.credentials, this.request.headers);
    log.info("CODEX-WS", `Opening ${this.connection.provider}/${this.connection.model} WebSocket upstream`);

    try {
      this.upstream = await createUpstreamSocket(upstreamUrl, headers, this.connection.credentials.providerSpecificData);
    } catch (error) {
      if (isCodexTurnStateOwnerUnavailable(error)) {
        clearCodexTurnAffinity({
          turnState: this.request.headers["x-codex-turn-state"],
          apiKey: this.apiKey,
        });
        throw createTurnStateOwnerUnavailableError(firstErrorMessage(error));
      }
      await markAccountUnavailable(
        this.connection.credentials.connectionId,
        Number(error.status) || 502,
        firstErrorMessage(error),
        this.connection.provider,
        this.connection.model,
      );
      this.accountFailureMarked = true;
      throw error;
    }

    this.upstream.on("message", (data, isBinary) => {
      this.refreshIdleTimer();
      if (isBinary) {
        this.fail(new Error("Upstream Responses WebSocket sent an unsupported binary frame"));
        return;
      }
      const text = data.toString();
      try {
        const event = JSON.parse(text);
        const ownerUnavailable = event?.type === "error"
          && isCodexTurnStateOwnerUnavailable(event?.error?.message || event?.message);
        if (ownerUnavailable) {
          this.upstreamErrorForwarded = true;
          clearCodexTurnAffinity({
            turnState: this.request.headers["x-codex-turn-state"],
            apiKey: this.apiKey,
          });
          sendError(
            this.client,
            event.error?.message || "Turn-state owner account is unavailable; retry the logical turn.",
            "turn_state_owner_unavailable",
            "invalid_request_error",
          );
          this.finalizePendingResponses(true);
          this.closing = true;
          clearTimeout(this.idleTimer);
          if (this.upstream.readyState < WebSocket.CLOSING) {
            this.upstream.close(1000, "Turn-state owner unavailable");
          }
          this.client.close(1008, "Turn-state owner unavailable");
          return;
        }
        if (event?.type === "response.created") {
          this.bindResponse(event.response?.id);
        } else if (event?.type === "response.completed" || event?.type === "response.done") {
          const response = this.findResponse(event);
          this.finalizeResponse(response, { usage: extractUsage(event) });
          setCodexTurnAffinity({
            turnState: this.request.headers["x-codex-turn-state"],
            apiKey: this.apiKey,
            provider: this.connection.provider,
            model: this.connection.model,
            connectionId: this.connection.credentials.connectionId,
          });
          clearAccountError(this.connection.credentials.connectionId, this.connection.credentials, this.connection.model).catch(() => {});
        } else if (["response.failed", "response.incomplete", "response.cancelled"].includes(event?.type)) {
          this.finalizeResponse(this.findResponse(event), { error: true });
        }
      } catch {
        // Preserve the upstream frame verbatim; Codex will diagnose invalid protocol data.
      }
      if (this.client.readyState === WebSocket.OPEN) this.client.send(text);
    });
    this.upstream.on("error", error => {
      if (!this.closing) this.fail(error);
    });
    // `ws` automatically replies to ping frames at each endpoint. Do not relay control
    // frames across the bridge: that creates extra unsolicited pings and couples each
    // peer's liveness policy to the other peer's timing.
    this.upstream.on("close", (code, reason) => {
      if (this.closing || this.client.readyState !== WebSocket.OPEN) return;

      if (this.hasPendingResponses()) {
        if (code !== 1000) {
          const error = Object.assign(
            new Error(`Upstream WebSocket closed (${code})`),
            { status: 502 },
          );
          this.fail(error);
          return;
        }
        this.finalizePendingResponses(true);
      }

      this.client.close(toClientCloseCode(code), reason.toString().slice(0, 123));
    });
    this.refreshIdleTimer();
  }

  async fail(error) {
    if (this.closing) return;
    const ownerUnavailable = isCodexTurnStateOwnerUnavailable(error);
    const status = Number(error.status) || (ownerUnavailable ? 409 : 502);
    log.warn("CODEX-WS", firstErrorMessage(error));
    if (ownerUnavailable) {
      clearCodexTurnAffinity({
        turnState: this.request.headers["x-codex-turn-state"],
        apiKey: this.apiKey,
      });
    }
    if (!this.upstreamErrorForwarded) {
      sendError(
        this.client,
        firstErrorMessage(error),
        ownerUnavailable ? "turn_state_owner_unavailable" : error.code || "upstream_error",
        ownerUnavailable ? "invalid_request_error" : error.type || "server_error",
      );
    }
    this.finalizePendingResponses(true);
    if (this.connection && status >= 500 && !ownerUnavailable && !this.accountFailureMarked) {
      await markAccountUnavailable(this.connection.credentials.connectionId, status, firstErrorMessage(error), this.connection.provider, this.connection.model);
      this.accountFailureMarked = true;
    }
    this.client.close(status >= 500 ? 1011 : 1008, "Responses WebSocket request failed");
  }

  closeUpstream() {
    if (this.closing) return;
    this.closing = true;
    this.finalizePendingResponses();
    clearTimeout(this.idleTimer);
    if (this.upstream && this.upstream.readyState < WebSocket.CLOSING) this.upstream.close(1000, "Downstream connection closed");
  }
}

function getServer() {
  if (server) return server;
  server = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES, perMessageDeflate: false });
  server.on("headers", (headers, request) => {
    const turnState = request._nineRouterTurnState;
    if (turnState) headers.push(`x-codex-turn-state: ${turnState}`);
  });
  server.on("connection", (client, request, apiKey) => {
    new ResponsesWebSocketRelay(client, request, apiKey).start();
  });
  return server;
}

export async function handleCodexResponsesWebSocketUpgrade(request, socket, head) {
  if (!isResponsesWebSocketPath(request.url)) {
    socket.destroy();
    return false;
  }
  const upgrade = String(request.headers.upgrade || "").toLowerCase();
  if (upgrade !== "websocket") {
    socket.destroy();
    return false;
  }

  let apiKey;
  try {
    apiKey = await authenticateUpgrade(request, socket);
  } catch {
    return true;
  }

  // codex-lb recognizes its own synthesized state as `turn_<uuid4 hex>`.
  // A raw UUID is interpreted as an explicit client-owned continuation and
  // fails closed because it has no recorded owner yet.
  request._nineRouterTurnState = request.headers["x-codex-turn-state"]
    || `turn_${randomUUID().replaceAll("-", "")}`;
  request.headers["x-codex-turn-state"] = request._nineRouterTurnState;
  getServer().handleUpgrade(request, socket, head, client => getServer().emit("connection", client, request, apiKey));
  return true;
}

export const __test__ = {
  buildUpstreamHeaders,
  getRequestApiKey,
  parseResponseCreate,
};
