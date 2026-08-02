import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("fs/promises", () => ({ default: fsMocks }));
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init = {}) => ({ body, status: init.status ?? 200 }),
  },
}));

import { POST } from "../../src/app/api/cli-tools/codex-settings/route.js";

describe("POST /api/cli-tools/codex-settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMocks.mkdir.mockResolvedValue(undefined);
    fsMocks.writeFile.mockResolvedValue(undefined);
  });

  it("does not overwrite an existing malformed config.toml", async () => {
    fsMocks.readFile.mockResolvedValueOnce("model = [malformed");

    const response = await POST({
      json: async () => ({
        baseUrl: "http://localhost:20128",
        apiKey: "secret",
        model: "lumi/gpt-5.6-sol",
        subagentModel: "lumi/gpt-5.6-terra",
      }),
    });

    expect(response).toEqual({
      body: { error: "Failed to update codex settings" },
      status: 500,
    });
    expect(fsMocks.writeFile).not.toHaveBeenCalled();
  });
});
