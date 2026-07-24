import { describe, expect, it, vi } from "vitest";

vi.mock("../../open-sse/translator/index.js", () => ({
  register: vi.fn(),
}));

import { openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses.js";

describe("openai → responses request parameters", () => {
  it("maps Chat Completions max_tokens to Responses max_output_tokens", () => {
    const out = openaiToOpenAIResponsesRequest(
      "gpt-5.6-sol",
      {
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 16,
      },
      true,
      null
    );

    expect(out.max_output_tokens).toBe(16);
    expect(out).not.toHaveProperty("max_tokens");
  });

  it("normalizes max_tokens when input is already Responses-shaped", () => {
    const out = openaiToOpenAIResponsesRequest(
      "gpt-5.6-sol",
      {
        input: [{ role: "user", content: "hi" }],
        max_tokens: 16,
      },
      true,
      null
    );

    expect(out.max_output_tokens).toBe(16);
    expect(out).not.toHaveProperty("max_tokens");
  });
});
