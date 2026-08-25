import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";

const mocks = vi.hoisted(() => ({
  settings: { requireApiKey: false },
  credentials: null,
  getModelInfo: vi.fn(),
  getProviderCredentials: vi.fn(),
  checkAndRefreshToken: vi.fn(),
  validateApiKey: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
}));

vi.mock("@/lib/db/index.js", () => ({
  getSettings: vi.fn(async () => mocks.settings),
  validateApiKey: mocks.validateApiKey,
}));

vi.mock("../../src/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
}));

vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
}));

vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: mocks.checkAndRefreshToken,
}));

const { handleCodexResponsesWebSocketUpgrade } = await import("../../src/sse/services/codexWebSocket.js");
const { __test__: turnAffinityTest } = await import("../../src/sse/services/codexTurnAffinity.js");

const provider = "openai-compatible-responses-test";
let upstream;
let gateway;
let upstreamSockets;
let clients;

function listen(server) {
  return new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise(resolve => server.close(resolve));
}

function waitForMessage(socket, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Timed out waiting for WebSocket message"));
    }, 2_000);
    timeout.unref?.();

    const onMessage = (data, isBinary) => {
      if (isBinary) return;
      const text = data.toString();
      if (!predicate(text)) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(text);
    };
    socket.on("message", onMessage);
  });
}

function connectClient(url, options) {
  let client;
  const opened = new Promise((resolve, reject) => {
    client = new WebSocket(url, options);
    client.once("open", resolve);
    client.once("error", reject);
  });
  clients.push(client);
  return { client, opened };
}

function waitForUnexpectedResponse(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for upgrade rejection")), 2_000);
    timeout.unref?.();
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timeout);
      response.resume();
      resolve(response);
    });
    socket.once("error", reject);
  });
}

async function closeSocket(socket) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  const closed = once(socket, "close").catch(() => {});
  socket.close();
  await closed;
}

beforeEach(async () => {
  upstreamSockets = [];
  clients = [];
  mocks.settings = { requireApiKey: false };
  mocks.getModelInfo.mockReset().mockResolvedValue({ provider, model: "gpt-test" });
  mocks.getProviderCredentials.mockReset();
  mocks.checkAndRefreshToken.mockReset();
  mocks.validateApiKey.mockReset().mockResolvedValue(false);
  mocks.markAccountUnavailable.mockReset().mockResolvedValue({ shouldFallback: true });
  mocks.clearAccountError.mockReset().mockResolvedValue();
  turnAffinityTest.clear();

  upstream = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false });
  upstream.on("connection", socket => upstreamSockets.push(socket));
  await once(upstream, "listening");

  const baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  mocks.credentials = {
    connectionId: "connection-test",
    apiKey: "selected-upstream-key",
    providerSpecificData: { baseUrl, apiType: "responses" },
  };
  mocks.getProviderCredentials.mockResolvedValue(mocks.credentials);
  mocks.checkAndRefreshToken.mockResolvedValue(mocks.credentials);

  gateway = http.createServer();
  gateway.on("upgrade", (request, socket, head) => {
    handleCodexResponsesWebSocketUpgrade(request, socket, head);
  });
  await listen(gateway);
});

afterEach(async () => {
  for (const client of clients) await closeSocket(client);
  for (const socket of upstreamSockets) await closeSocket(socket);
  await closeServer(gateway);
  await new Promise(resolve => upstream.close(resolve));
});

function gatewayUrl() {
  return `ws://127.0.0.1:${gateway.address().port}/v1/responses`;
}

describe("Codex Responses WebSocket relay", () => {
  it("authenticates before upgrade and does not open an upstream connection for an invalid key", async () => {
    mocks.settings = { requireApiKey: true };
    mocks.validateApiKey.mockResolvedValue(false);

    const client = new WebSocket(gatewayUrl(), {
      headers: { Authorization: "Bearer invalid-router-key" },
    });
    clients.push(client);
    const response = await waitForUnexpectedResponse(client);

    expect(response.statusCode).toBe(401);
    expect(upstreamSockets).toHaveLength(0);
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
  });

  it("preserves a client-provided turn state through both handshakes", async () => {
    const turnState = "turn-provided-by-codex";
    const client = new WebSocket(gatewayUrl(), {
      headers: { "x-codex-turn-state": turnState },
    });
    clients.push(client);
    const upgrade = once(client, "upgrade");
    const opened = once(client, "open");
    await opened;
    const [upgradeResponse] = await upgrade;

    expect(upgradeResponse.headers["x-codex-turn-state"]).toBe(turnState);

    const connectedUpstream = once(upstream, "connection");
    client.send(JSON.stringify({
      type: "response.create",
      response: { model: "mock/gpt-test" },
    }));
    const [, upstreamRequest] = await connectedUpstream;
    expect(upstreamRequest.headers["x-codex-turn-state"]).toBe(turnState);
  });

  it("pins one selected Responses connection and relays its events without leaking client credentials", async () => {
    const { client, opened } = connectClient(gatewayUrl(), {
      headers: {
        Authorization: "Bearer router-client-key",
        Cookie: "router-session=secret",
        originator: "codex_cli_rs",
        "x-codex-beta-features": "feature-a",
      },
    });
    await opened;

    const connectedUpstream = once(upstream, "connection");
    client.send(JSON.stringify({
      type: "response.create",
      response: { model: "mock/gpt-test", input: "Hello" },
    }));

    const [upstreamClient, upstreamRequest] = await connectedUpstream;
    const turnState = upstreamRequest.headers["x-codex-turn-state"];
    expect(turnState).toMatch(/^turn_[0-9a-f]{32}$/);
    expect(upstreamRequest.headers.authorization).toBe("Bearer selected-upstream-key");
    expect(upstreamRequest.headers.cookie).toBeUndefined();
    expect(upstreamRequest.headers.originator).toBe("codex_cli_rs");
    expect(upstreamRequest.headers["x-codex-beta-features"]).toBe("feature-a");
    expect(upstreamRequest.headers["x-codex-turn-state"]).toBe(turnState);

    const upstreamFrame = await waitForMessage(upstreamClient);
    expect(JSON.parse(upstreamFrame)).toMatchObject({
      type: "response.create",
      response: { model: "gpt-test", input: "Hello" },
    });

    const created = waitForMessage(client, text => JSON.parse(text).type === "response.created");
    upstreamClient.send(JSON.stringify({ type: "response.created", response: { id: "resp_1" } }));
    expect(JSON.parse(await created)).toMatchObject({ type: "response.created", response: { id: "resp_1" } });

    const completed = waitForMessage(client, text => JSON.parse(text).type === "response.completed");
    upstreamClient.send(JSON.stringify({ type: "response.completed", response: { id: "resp_1" } }));
    await completed;
    await vi.waitFor(() => expect(mocks.clearAccountError).toHaveBeenCalledWith(
      "connection-test",
      mocks.credentials,
      "gpt-test",
    ));

    const upstreamClosed = once(upstreamClient, "close");
    await closeSocket(client);
    const [closeCode] = await upstreamClosed;
    expect(closeCode).toBe(1000);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("keeps a turn state on its original account across reconnects", async () => {
    const turnState = "turn-account-a";
    const first = connectClient(gatewayUrl(), { headers: { "x-codex-turn-state": turnState } });
    await first.opened;
    const firstConnected = once(upstream, "connection");
    first.client.send(JSON.stringify({ type: "response.create", response: { model: "mock/gpt-test" } }));
    const [firstUpstream] = await firstConnected;
    await waitForMessage(firstUpstream);
    await closeSocket(first.client);
    await closeSocket(firstUpstream);

    const accountB = { ...mocks.credentials, connectionId: "connection-other", apiKey: "other-key" };
    mocks.getProviderCredentials.mockImplementation(async (_provider, _excluded, _model, options) => {
      if (options?.strictPreferredConnection) return mocks.credentials;
      return accountB;
    });

    const second = connectClient(gatewayUrl(), { headers: { "x-codex-turn-state": turnState } });
    await second.opened;
    const secondConnected = once(upstream, "connection");
    second.client.send(JSON.stringify({ type: "response.create", response: { model: "mock/gpt-test" } }));
    const [, request] = await secondConnected;
    expect(request.headers.authorization).toBe("Bearer selected-upstream-key");
    expect(mocks.getProviderCredentials).toHaveBeenLastCalledWith(
      provider,
      null,
      "gpt-test",
      expect.objectContaining({ preferredConnectionId: "connection-test", strictPreferredConnection: true }),
    );
  });

  it("does not lock an account for an owner-bound turn error", async () => {
    const { client, opened } = connectClient(gatewayUrl());
    await opened;

    const connectedUpstream = once(upstream, "connection");
    const failed = waitForMessage(client, text => JSON.parse(text).type === "error");
    client.send(JSON.stringify({
      type: "response.create",
      response: { model: "mock/gpt-test" },
    }));

    const [upstreamClient] = await connectedUpstream;
    await waitForMessage(upstreamClient);
    upstreamClient.send(JSON.stringify({
      type: "error",
      error: { message: "Turn-state owner account is unavailable; retry the logical turn." },
    }));

    expect(JSON.parse(await failed).error).toMatchObject({
      code: "turn_state_owner_unavailable",
      type: "invalid_request_error",
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("marks the pinned account unavailable when its upstream fails before completion", async () => {
    const { client, opened } = connectClient(gatewayUrl());
    await opened;

    const connectedUpstream = once(upstream, "connection");
    const failed = waitForMessage(client, text => JSON.parse(text).type === "error");
    client.send(JSON.stringify({
      type: "response.create",
      response: { model: "mock/gpt-test" },
    }));

    const [upstreamClient] = await connectedUpstream;
    upstreamClient.close(1011, "upstream failed");

    const event = JSON.parse(await failed);
    expect(event.error).toMatchObject({ code: "upstream_error", type: "server_error" });
    await vi.waitFor(() => expect(mocks.markAccountUnavailable).toHaveBeenCalledWith(
      "connection-test",
      502,
      expect.stringContaining("Upstream WebSocket closed (1011)"),
      provider,
      "gpt-test",
    ));
    await closeSocket(client);
  });
});
