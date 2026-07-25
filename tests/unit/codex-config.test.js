import { describe, expect, it } from "vitest";
import {
  apply9RouterCodexConfig,
  buildCodexManualConfig,
  readCodexConfiguredModels,
  reset9RouterCodexConfig,
} from "../../src/lib/codexConfig.js";

const existingConfig = {
  model: "old-main",
  model_provider: "other-provider",
  approval_policy: "never",
  model_providers: {
    existing: { name: "Existing", base_url: "https://existing.example/v1" },
    "9router": { request_max_retries: 7 },
  },
  agents: {
    enabled: true,
    max_concurrent_threads_per_session: 6,
    interrupt_message: false,
    subagent: { model: "obsolete-model" },
  },
};

describe("apply9RouterCodexConfig", () => {
  it("writes the current default subagent schema and preserves unrelated config", () => {
    const input = structuredClone(existingConfig);
    const result = apply9RouterCodexConfig(input, {
      baseUrl: "http://localhost:20128/v1",
      model: "lumi/gpt-5.6-sol",
      subagentModel: "lumi/gpt-5.6-terra",
    });

    expect(result).toMatchObject({
      model: "lumi/gpt-5.6-sol",
      model_provider: "9router",
      approval_policy: "never",
      model_providers: {
        existing: { name: "Existing", base_url: "https://existing.example/v1" },
        "9router": {
          name: "9Router",
          base_url: "http://localhost:20128/v1",
          wire_api: "responses",
          request_max_retries: 7,
        },
      },
      agents: {
        enabled: true,
        max_concurrent_threads_per_session: 6,
        interrupt_message: false,
        default_subagent_model: "lumi/gpt-5.6-terra",
      },
    });
    expect(result.agents.subagent).toBeUndefined();
    expect(input).toEqual(existingConfig);
  });

  it("falls back to the main model when no subagent model is supplied", () => {
    const result = apply9RouterCodexConfig({}, {
      baseUrl: "http://localhost:20128/v1",
      model: "lumi/gpt-5.6-sol",
    });

    expect(result.agents.default_subagent_model).toBe("lumi/gpt-5.6-sol");
  });
});

describe("reset9RouterCodexConfig", () => {
  it("removes current and obsolete settings without deleting unrelated agent fields", () => {
    const input = apply9RouterCodexConfig(existingConfig, {
      baseUrl: "http://localhost:20128/v1",
      model: "lumi/gpt-5.6-sol",
      subagentModel: "lumi/gpt-5.6-terra",
    });
    input.agents.subagent = { model: "stale" };
    const snapshot = structuredClone(input);

    const result = reset9RouterCodexConfig(input);

    expect(result.model).toBeUndefined();
    expect(result.model_provider).toBeUndefined();
    expect(result.model_providers["9router"]).toBeUndefined();
    expect(result.model_providers.existing).toEqual(existingConfig.model_providers.existing);
    expect(result.agents).toEqual({
      enabled: true,
      max_concurrent_threads_per_session: 6,
      interrupt_message: false,
    });
    expect(input).toEqual(snapshot);
  });

  it("keeps a non-9Router root model selection", () => {
    const result = reset9RouterCodexConfig({
      model: "third-party-model",
      model_provider: "third-party",
      agents: { default_subagent_model: "router-owned-fallback" },
    });

    expect(result.model).toBe("third-party-model");
    expect(result.model_provider).toBe("third-party");
    expect(result.agents).toBeUndefined();
  });
});

describe("Codex dashboard configuration helpers", () => {
  it("reads the main and current default subagent models from TOML", () => {
    expect(readCodexConfiguredModels(`
model = "lumi/gpt-5.6-sol"

[agents]
enabled = true
default_subagent_model = "lumi/gpt-5.6-terra"
`)).toEqual({
      model: "lumi/gpt-5.6-sol",
      subagentModel: "lumi/gpt-5.6-terra",
    });
  });

  it("returns empty model values for absent or invalid TOML", () => {
    expect(readCodexConfiguredModels(null)).toEqual({ model: "", subagentModel: "" });
    expect(readCodexConfiguredModels("not = [valid")).toEqual({ model: "", subagentModel: "" });
  });

  it("builds a manual preview using the current schema", () => {
    const preview = buildCodexManualConfig({
      baseUrl: "http://localhost:20128/v1",
      model: "lumi/gpt-5.6-sol",
      subagentModel: "lumi/gpt-5.6-terra",
    });

    expect(preview).toContain("[agents]");
    expect(preview).toContain('default_subagent_model = "lumi/gpt-5.6-terra"');
    expect(preview).not.toContain("[agents.subagent]");
  });
});
