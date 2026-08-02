import { beforeEach, describe, expect, it, vi } from "vitest";

const { handleChatCore } = vi.hoisted(() => ({
  handleChatCore: vi.fn(),
}));

vi.mock("../../open-sse/handlers/chatCore.js", () => ({ handleChatCore }));

import { handleResponsesCore } from "../../open-sse/handlers/responsesHandler.js";

describe("Responses handler request details", () => {
  beforeEach(() => {
    handleChatCore.mockReset();
    handleChatCore.mockResolvedValue({ success: false, status: 400, error: "stop" });
  });

  it("passes the original Responses body separately for observability", async () => {
    const body = {
      model: "gpt-5.6-sol",
      input: [{ type: "message", role: "user", content: "hello" }],
      instructions: "Follow the repository rules.",
      stream: true,
    };

    await handleResponsesCore({
      body,
      modelInfo: { provider: "openai", model: "gpt-5.6-sol" },
      credentials: {},
    });

    expect(handleChatCore).toHaveBeenCalledWith(expect.objectContaining({
      requestDetailBody: body,
    }));
  });
});
