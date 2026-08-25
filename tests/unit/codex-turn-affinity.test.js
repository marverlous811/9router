import { afterEach, describe, expect, it } from "vitest";
import {
  __test__,
  clearCodexTurnAffinity,
  createTurnStateOwnerUnavailableError,
  getCodexTurnAffinity,
  isCodexTurnStateOwnerUnavailable,
  setCodexTurnAffinity,
} from "../../src/sse/services/codexTurnAffinity.js";

afterEach(() => __test__.clear());

describe("Codex turn-state affinity", () => {
  it("pins a turn state to its selected account within one API-key scope", () => {
    setCodexTurnAffinity({
      turnState: "turn_123",
      apiKey: "client-a",
      provider: "openai-compatible-responses-test",
      model: "gpt-test",
      connectionId: "account-a",
    });

    expect(getCodexTurnAffinity({
      turnState: "turn_123",
      apiKey: "client-a",
      provider: "openai-compatible-responses-test",
      model: "gpt-test",
    })).toMatchObject({ connectionId: "account-a" });
    expect(getCodexTurnAffinity({
      turnState: "turn_123",
      apiKey: "client-b",
      provider: "openai-compatible-responses-test",
      model: "gpt-test",
    })).toBeNull();
  });

  it("does not reuse an affinity for a different provider/model", () => {
    setCodexTurnAffinity({
      turnState: "turn_123",
      provider: "openai-compatible-responses-test",
      model: "gpt-test",
      connectionId: "account-a",
    });

    expect(getCodexTurnAffinity({
      turnState: "turn_123",
      provider: "openai-compatible-responses-test",
      model: "gpt-other",
    })).toBeNull();
    expect(clearCodexTurnAffinity({ turnState: "turn_123" })).toBe(true);
  });

  it("recognizes only the owner-bound turn error", () => {
    expect(isCodexTurnStateOwnerUnavailable(
      "Turn-state owner account is unavailable; retry the logical turn.",
    )).toBe(true);
    expect(isCodexTurnStateOwnerUnavailable("Selected model is at capacity")).toBe(false);
    expect(createTurnStateOwnerUnavailableError()).toMatchObject({
      status: 409,
      code: "turn_state_owner_unavailable",
    });
  });
});
