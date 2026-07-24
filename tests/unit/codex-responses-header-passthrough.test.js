import { describe, expect, it } from "vitest";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { translateRequest } from "../../open-sse/translator/index.js";

const CODEX_HEADERS = {
  originator: "codex_cli_rs",
  "session-id": "session-child",
  "thread-id": "thread-child",
  "user-agent": "codex_cli_rs/0.145.0",
  "x-client-request-id": "request-child",
  "x-codex-beta-features": "remote_compaction_v2",
  "x-codex-turn-metadata": JSON.stringify({
    request_kind: "turn",
    thread_source: "subagent",
  }),
  "x-codex-window-id": "thread-child:0",
  "x-openai-internal-codex-responses-lite": "true",
};

const SENSITIVE_HEADERS = {
  authorization: "Bearer client-secret",
  cookie: "session=client-secret",
  "x-api-key": "client-secret",
  host: "attacker.example",
  "content-length": "999",
  "x-forwarded-for": "203.0.113.7",
  "x-unreviewed-metadata": "must-not-pass",
};

function alternatingCase(name) {
  let uppercaseNext = true;
  return name.replace(/[a-z]/g, character => {
    const replacement = uppercaseNext ? character.toUpperCase() : character;
    uppercaseNext = !uppercaseNext;
    return replacement;
  });
}

const CASE_VARIANT_CODEX_HEADERS = Object.fromEntries(
  Object.entries(CODEX_HEADERS).map(([name, value]) => [alternatingCase(name), value]),
);
const CASE_VARIANT_SENSITIVE_HEADERS = Object.fromEntries(
  Object.entries(SENSITIVE_HEADERS).map(([name, value]) => [alternatingCase(name), value]),
);
const CODEX_HEADER_NAMES = Object.keys(CODEX_HEADERS);
const SENSITIVE_HEADER_NAMES = Object.keys(SENSITIVE_HEADERS)
  .filter(name => name !== "authorization");

function findHeaders(headers, name) {
  return Object.entries(headers)
    .filter(([headerName]) => headerName.toLowerCase() === name.toLowerCase());
}

function canonicalHeaderNames(headers) {
  return Object.keys(headers).map(name => name.toLowerCase()).sort();
}

function canonicalHeaderValues(headers) {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
}

function expectNativeResponsesHeaders(headers) {
  expect(canonicalHeaderNames(headers)).toEqual([
    ...CODEX_HEADER_NAMES,
    "accept",
    "authorization",
    "content-type",
  ].sort());
  expect(canonicalHeaderValues(headers)).toEqual({
    accept: "text/event-stream",
    authorization: "Bearer router-secret",
    "content-type": "application/json",
    ...CODEX_HEADERS,
  });
  for (const name of SENSITIVE_HEADER_NAMES) {
    expect(findHeaders(headers, name), `${name} must not be forwarded`).toHaveLength(0);
  }
  const authorizationHeaders = findHeaders(headers, "authorization");
  expect(authorizationHeaders).toHaveLength(1);
  expect(authorizationHeaders[0][1]).toBe("Bearer router-secret");
  const userAgentHeaders = findHeaders(headers, "user-agent");
  expect(userAgentHeaders).toHaveLength(1);
  expect(userAgentHeaders[0][1]).toBe(CODEX_HEADERS["user-agent"]);
}

function expectChatCompletionsHeaders(headers) {
  for (const name of CODEX_HEADER_NAMES.filter(name => name !== "user-agent")) {
    expect(findHeaders(headers, name), `${name} must stay on Responses transports`).toHaveLength(0);
  }
  for (const name of SENSITIVE_HEADER_NAMES) {
    expect(findHeaders(headers, name), `${name} must not be forwarded`).toHaveLength(0);
  }
  for (const [, value] of findHeaders(headers, "user-agent")) {
    expect(value).not.toBe(CODEX_HEADERS["user-agent"]);
  }
  const authorizationHeaders = findHeaders(headers, "authorization");
  expect(authorizationHeaders).toHaveLength(1);
  expect(authorizationHeaders[0][1]).toBe("Bearer router-secret");
}

describe("Codex Responses metadata passthrough", () => {
  it("forwards only allowlisted metadata to dynamic Responses providers", () => {
    const executor = new DefaultExecutor("openai-compatible-responses-test");
    const productionHeaders = executor.buildHeaders({
      apiKey: "router-secret",
      rawHeaders: { ...CODEX_HEADERS, ...SENSITIVE_HEADERS },
    }, true);
    expectNativeResponsesHeaders(productionHeaders);

    const caseVariantHeaders = executor.buildHeaders({
      apiKey: "router-secret",
      rawHeaders: { ...CASE_VARIANT_CODEX_HEADERS, ...CASE_VARIANT_SENSITIVE_HEADERS },
    }, true);
    expectNativeResponsesHeaders(caseVariantHeaders);
  });

  it("forwards metadata for an explicitly resolved Responses transport", () => {
    const executor = new DefaultExecutor("openai");
    const headers = executor.buildHeaders({
      apiKey: "router-secret",
      rawHeaders: { ...CASE_VARIANT_CODEX_HEADERS, ...CASE_VARIANT_SENSITIVE_HEADERS },
      runtimeTransport: {
        format: FORMATS.OPENAI_RESPONSES,
        headers: { "User-Agent": "router-default" },
      },
    }, true);

    expectNativeResponsesHeaders(headers);
  });

  it("does not forward Codex metadata to Chat Completions transports", () => {
    const executor = new DefaultExecutor("openai-compatible-test");
    const dynamicHeaders = executor.buildHeaders({
      apiKey: "router-secret",
      rawHeaders: { ...CODEX_HEADERS, ...SENSITIVE_HEADERS },
    }, true);
    expectChatCompletionsHeaders(dynamicHeaders);

    const runtimeExecutor = new DefaultExecutor("openai");
    const runtimeHeaders = runtimeExecutor.buildHeaders({
      apiKey: "router-secret",
      rawHeaders: { ...CASE_VARIANT_CODEX_HEADERS, ...CASE_VARIANT_SENSITIVE_HEADERS },
      runtimeTransport: {
        format: FORMATS.OPENAI,
        headers: { "User-Agent": "router-chat-default" },
      },
    }, true);
    expectChatCompletionsHeaders(runtimeHeaders);
  });

  it("keeps encrypted agent_message input unchanged on native Responses routes", () => {
    const agentMessage = {
      type: "agent_message",
      author: "/root",
      recipient: "/root/probe",
      content: [
        { type: "input_text", text: "Message Type: NEW_TASK\nPayload:\n" },
        { type: "encrypted_content", encrypted_content: "encrypted-task" },
      ],
    };
    const body = { model: "gpt-5.6-sol", input: [agentMessage], stream: true };
    const snapshot = structuredClone(body);

    const result = translateRequest(
      FORMATS.OPENAI_RESPONSES,
      FORMATS.OPENAI_RESPONSES,
      body.model,
      body,
      true,
      null,
      "openai-compatible-responses-test",
    );

    expect(result).toEqual(snapshot);
    expect(body).toEqual(snapshot);
  });
});
