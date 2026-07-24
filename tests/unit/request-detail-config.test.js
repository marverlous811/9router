import { describe, expect, it } from "vitest";
import { extractRequestConfig } from "../../open-sse/handlers/chatCore/requestDetail.js";

describe("request detail config", () => {
  it("records Responses API input and instructions instead of an empty messages array", () => {
    const input = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
    ];

    const config = extractRequestConfig({
      model: "gpt-5.6-sol",
      input,
      instructions: "Follow the repository rules.",
      reasoning: { effort: "medium", context: "all_turns" },
    }, true);

    expect(config.input).toEqual(input);
    expect(config.instructions).toBe("Follow the repository rules.");
    expect(config).not.toHaveProperty("messages");
  });
});
