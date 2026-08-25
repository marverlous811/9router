import { describe, expect, it } from "vitest";
import {
  buildResponsesWebSocketUrl,
  buildUpstreamHeaders,
  getRequestApiKey,
  isResponsesWebSocketPath,
  parseResponseCreate,
  resolveWebSocketProxy,
  shouldBypassProxy,
} from "../../src/sse/services/codexWebSocket.js";

describe("Codex Responses WebSocket helpers", () => {
  it("accepts only the public Responses upgrade paths", () => {
    expect(isResponsesWebSocketPath("/v1/responses")).toBe(true);
    expect(isResponsesWebSocketPath("/v1/responses/?trace=1")).toBe(true);
    expect(isResponsesWebSocketPath("/api/v1/responses")).toBe(false);
    expect(isResponsesWebSocketPath("/v1/chat/completions")).toBe(false);
  });

  it("converts configured HTTP bases to exactly one Responses WebSocket endpoint", () => {
    expect(buildResponsesWebSocketUrl("https://lb.example/v1")).toBe("wss://lb.example/v1/responses");
    expect(buildResponsesWebSocketUrl("http://localhost:2455/backend-api/codex/")).toBe(
      "ws://localhost:2455/backend-api/codex/responses",
    );
    expect(buildResponsesWebSocketUrl("wss://lb.example/v1/responses")).toBe(
      "wss://lb.example/v1/responses",
    );
    expect(() => buildResponsesWebSocketUrl("ftp://lb.example/v1")).toThrow("HTTP(S) or WS(S)");
  });

  it("uses only sanctioned Codex headers and replaces client authorization", () => {
    const headers = buildUpstreamHeaders(
      { apiKey: "selected-upstream-key", providerSpecificData: { chatgptAccountId: "acct_123" } },
      {
        authorization: "Bearer router-client-key",
        cookie: "session=client-cookie",
        host: "router.test",
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": "client-key",
        "originator": "codex_cli_rs",
        "x-codex-beta-features": "feature-a",
        "x-codex-turn-state": "turn_123",
      },
    );

    expect(headers).toMatchObject({
      Authorization: "Bearer selected-upstream-key",
      "ChatGPT-Account-ID": "acct_123",
      "OpenAI-Beta": "responses_websockets=2026-02-06",
      originator: "codex_cli_rs",
      "x-codex-beta-features": "feature-a",
      "x-codex-turn-state": "turn_123",
    });
    expect(headers.cookie).toBeUndefined();
    expect(headers.host).toBeUndefined();
    expect(headers.connection).toBeUndefined();
    expect(headers.upgrade).toBeUndefined();
    expect(headers["sec-websocket-key"]).toBeUndefined();
  });

  it("requires selected upstream credentials instead of reusing client authorization", () => {
    expect(() => buildUpstreamHeaders({}, { authorization: "Bearer router-client-key" })).toThrow(
      "no API key or access token",
    );
  });

  it("extracts only supported 9Router client credential headers", () => {
    expect(getRequestApiKey({ authorization: "Bearer router-key", "x-api-key": "fallback" })).toBe("router-key");
    expect(getRequestApiKey({ authorization: "Basic no", "x-api-key": "router-key" })).toBe("router-key");
    expect(getRequestApiKey({ authorization: "basic no" })).toBeNull();
  });

  it("validates the first client frame before it is sent upstream", () => {
    expect(parseResponseCreate(JSON.stringify({
      type: "response.create",
      response: { model: "lumi/gpt-5.6-terra" },
    }))).toMatchObject({ model: "lumi/gpt-5.6-terra" });

    expect(() => parseResponseCreate("not json")).toThrow("valid JSON text");
    expect(() => parseResponseCreate(JSON.stringify({ type: "response.cancel" }))).toThrow("first Responses WebSocket frame");
    expect(() => parseResponseCreate(JSON.stringify({ type: "response.create", response: {} }))).toThrow("include a model");
  });

  it("honors NO_PROXY and fails explicitly for relay proxy pools", () => {
    expect(shouldBypassProxy("wss://api.example.com/v1/responses", ".example.com,localhost")).toBe(true);
    expect(shouldBypassProxy("wss://api.other.test/v1/responses", ".example.com")).toBe(false);
    expect(resolveWebSocketProxy("wss://api.example.com/v1/responses", {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.test:8080",
      connectionNoProxy: ".example.com",
    })).toBeNull();
    expect(() => resolveWebSocketProxy("wss://api.example.com/v1/responses", {
      vercelRelayUrl: "https://relay.example",
    })).toThrow("do not support native WebSocket");
  });

  it("uses the matching HTTP or HTTPS environment proxy for the upstream protocol", () => {
    const previous = {
      HTTP_PROXY: process.env.HTTP_PROXY,
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      ALL_PROXY: process.env.ALL_PROXY,
    };
    process.env.HTTP_PROXY = "http://http-proxy.test:8080";
    process.env.HTTPS_PROXY = "http://https-proxy.test:8080";
    delete process.env.ALL_PROXY;

    try {
      expect(resolveWebSocketProxy("ws://api.example.com/v1/responses")).toBe("http://http-proxy.test:8080");
      expect(resolveWebSocketProxy("wss://api.example.com/v1/responses")).toBe("http://https-proxy.test:8080");
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
