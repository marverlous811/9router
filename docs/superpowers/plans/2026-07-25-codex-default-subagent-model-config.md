# Codex Default Subagent Model Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make 9Router read, write, preview, migrate, and reset Codex CLI's current `agents.default_subagent_model` setting while preserving unrelated TOML configuration.

**Architecture:** Move Codex TOML transformations and dashboard parsing/preview generation into a pure `src/lib/codexConfig.js` module. Keep the API route responsible for HTTP, filesystem, and auth JSON operations, and make the dashboard consume the same helper contract so automatic and manual configuration cannot drift.

**Tech Stack:** JavaScript ESM, Next.js App Router, React, `confbox`, Vitest

---

## File Map

- Create `src/lib/codexConfig.js`: pure apply/reset/read/manual-preview helpers.
- Create `tests/unit/codex-config.test.js`: schema, preservation, migration, immutability, parsing, and preview regression tests.
- Modify `src/app/api/cli-tools/codex-settings/route.js`: delegate TOML transformations to the helper.
- Modify `src/app/(dashboard)/dashboard/cli-tools/components/CodexToolCard.js`: consume shared read/preview helpers.
- Modify `CHANGELOG.md`: record the corrected Codex setting.

### Task 1: Pure Codex configuration transformation

**Files:**
- Create: `tests/unit/codex-config.test.js`
- Create: `src/lib/codexConfig.js`

- [ ] **Step 1: Write failing apply/reset regression tests**

Create `tests/unit/codex-config.test.js`:

```js
import { describe, expect, it } from "vitest";
import {
  apply9RouterCodexConfig,
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
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd tests && npx vitest run unit/codex-config.test.js`

Expected: FAIL because `src/lib/codexConfig.js` does not exist.

- [ ] **Step 3: Implement the minimal immutable transformation helpers**

Create `src/lib/codexConfig.js`:

```js
function cloneConfig(config) {
  return structuredClone(config ?? {});
}

function removeEmptyObject(parent, key) {
  const value = parent?.[key];
  if (value && typeof value === "object" && Object.keys(value).length === 0) {
    delete parent[key];
  }
}

export function apply9RouterCodexConfig(config, { baseUrl, model, subagentModel }) {
  const next = cloneConfig(config);
  next.model = model;
  next.model_provider = "9router";
  next.model_providers = { ...(next.model_providers ?? {}) };
  next.model_providers["9router"] = {
    ...(next.model_providers["9router"] ?? {}),
    name: "9Router",
    base_url: baseUrl,
    wire_api: "responses",
  };
  next.agents = { ...(next.agents ?? {}) };
  delete next.agents.subagent;
  next.agents.default_subagent_model = subagentModel || model;
  return next;
}

export function reset9RouterCodexConfig(config) {
  const next = cloneConfig(config);
  if (next.model_provider === "9router") {
    delete next.model;
    delete next.model_provider;
  }
  if (next.model_providers && typeof next.model_providers === "object") {
    delete next.model_providers["9router"];
    removeEmptyObject(next, "model_providers");
  }
  if (next.agents && typeof next.agents === "object") {
    delete next.agents.default_subagent_model;
    delete next.agents.subagent;
    removeEmptyObject(next, "agents");
  }
  return next;
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `cd tests && npx vitest run unit/codex-config.test.js`

Expected: all apply/reset tests PASS.

- [ ] **Step 5: Commit the transformation helper**

```bash
git add src/lib/codexConfig.js tests/unit/codex-config.test.js
git commit -m "fix(codex): write default subagent model schema"
```

### Task 2: Shared config reading and manual preview

**Files:**
- Modify: `tests/unit/codex-config.test.js`
- Modify: `src/lib/codexConfig.js`

- [ ] **Step 1: Add failing read/preview tests**

Extend the helper imports with `buildCodexManualConfig` and
`readCodexConfiguredModels`, then add:

```js
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
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd tests && npx vitest run unit/codex-config.test.js`

Expected: FAIL because the two dashboard helper exports do not exist.

- [ ] **Step 3: Implement parsing and preview generation through `confbox`**

Add to `src/lib/codexConfig.js`:

```js
import { parseTOML, stringifyTOML } from "confbox";

export function readCodexConfiguredModels(configContent) {
  if (!configContent || typeof configContent !== "string") {
    return { model: "", subagentModel: "" };
  }
  try {
    const parsed = parseTOML(configContent);
    return {
      model: typeof parsed?.model === "string" ? parsed.model : "",
      subagentModel: typeof parsed?.agents?.default_subagent_model === "string"
        ? parsed.agents.default_subagent_model
        : "",
    };
  } catch {
    return { model: "", subagentModel: "" };
  }
}

export function buildCodexManualConfig(options) {
  const config = apply9RouterCodexConfig({}, options);
  return `# 9Router Configuration for Codex CLI\n${stringifyTOML(config)}`;
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `cd tests && npx vitest run unit/codex-config.test.js`

Expected: apply, reset, read, and preview tests PASS.

- [ ] **Step 5: Commit the dashboard-facing helpers**

```bash
git add src/lib/codexConfig.js tests/unit/codex-config.test.js
git commit -m "test(codex): cover subagent config parsing and preview"
```

### Task 3: Wire the API route to the tested helper

**Files:**
- Modify: `tests/unit/codex-config.test.js`
- Modify: `src/app/api/cli-tools/codex-settings/route.js`

- [ ] **Step 1: Add a serialization round-trip regression test**

Import `parseTOML` and `stringifyTOML` from `confbox`, then add:

```js
it("survives the same confbox serialization round trip used by the API", () => {
  const applied = apply9RouterCodexConfig(parseTOML(`
approval_policy = "never"

[agents]
max_concurrent_threads_per_session = 4
`), {
    baseUrl: "http://localhost:20128/v1",
    model: "lumi/gpt-5.6-sol",
    subagentModel: "lumi/gpt-5.6-terra",
  });
  const reparsed = parseTOML(stringifyTOML(applied));
  expect(reparsed.agents).toEqual({
    max_concurrent_threads_per_session: 4,
    default_subagent_model: "lumi/gpt-5.6-terra",
  });
  expect(reparsed.approval_policy).toBe("never");
});
```

- [ ] **Step 2: Run the focused test across the serialization boundary**

Run: `cd tests && npx vitest run unit/codex-config.test.js`

Expected: PASS, proving helper output survives the route's serializer.

- [ ] **Step 3: Replace route-local mutation with helper calls**

In `src/app/api/cli-tools/codex-settings/route.js`:

- import `apply9RouterCodexConfig` and `reset9RouterCodexConfig` from
  `@/lib/codexConfig.js`;
- remove `parsedToWritable`, `setNestedSection`, and `deleteNestedSection`;
- after parsing POST input, normalize the URL and call:

```js
const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
parsed = apply9RouterCodexConfig(parsed, {
  baseUrl: normalizedBaseUrl,
  model,
  subagentModel,
});
```

- replace the DELETE root/provider/agent deletion block with:

```js
parsed = reset9RouterCodexConfig(parsed);
```

Keep validation, filesystem, auth JSON, and response behavior unchanged.

- [ ] **Step 4: Run focused tests and lint**

```bash
cd tests && npx vitest run unit/codex-config.test.js
cd .. && npx eslint src/lib/codexConfig.js src/app/api/cli-tools/codex-settings/route.js
```

Expected: tests PASS and ESLint exits 0.

- [ ] **Step 5: Commit the API integration**

```bash
git add src/app/api/cli-tools/codex-settings/route.js tests/unit/codex-config.test.js
git commit -m "refactor(codex): centralize CLI config updates"
```

### Task 4: Wire the dashboard and record the fix

**Files:**
- Modify: `src/app/(dashboard)/dashboard/cli-tools/components/CodexToolCard.js`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Replace regex parsing and manual template generation**

Import:

```js
import {
  buildCodexManualConfig,
  readCodexConfiguredModels,
} from "@/lib/codexConfig.js";
```

Replace the config parsing effect with:

```js
useEffect(() => {
  if (!codexStatus?.config) return;
  const configured = readCodexConfiguredModels(codexStatus.config);
  setSelectedModel(configured.model);
  setSubagentModel(configured.subagentModel);
}, [codexStatus]);
```

Replace the hand-written `configContent` template with:

```js
const configContent = buildCodexManualConfig({
  baseUrl: getEffectiveBaseUrl(),
  model: selectedModel,
  subagentModel: effectiveSubagentModel,
});
```

Keep auth preview generation and modal behavior unchanged.

- [ ] **Step 2: Add the changelog entry**

Under the current unreleased section of `CHANGELOG.md`, add:

```md
- **Codex**: write the current `agents.default_subagent_model` setting and preserve unrelated agent configuration.
```

- [ ] **Step 3: Run tests, lint, and whitespace checks**

```bash
cd tests && npx vitest run unit/codex-config.test.js
cd .. && npx eslint src/lib/codexConfig.js src/app/api/cli-tools/codex-settings/route.js 'src/app/(dashboard)/dashboard/cli-tools/components/CodexToolCard.js'
git diff --check
```

Expected: tests PASS, ESLint exits 0, and diff check has no output.

- [ ] **Step 4: Run adjacent Codex regressions**

```bash
cd tests && npx vitest run unit/codex-config.test.js unit/codex-responses-header-passthrough.test.js unit/codex-fast-capacity.test.js
```

Expected: all selected files PASS.

- [ ] **Step 5: Commit the dashboard and changelog update**

```bash
git add 'src/app/(dashboard)/dashboard/cli-tools/components/CodexToolCard.js' CHANGELOG.md
git commit -m "fix(codex): use current subagent fallback setting"
```

### Task 5: Final verification

**Files:**
- Verify only; no planned file changes.

- [ ] **Step 1: Run the complete focused verification set**

```bash
cd tests && npx vitest run unit/codex-config.test.js unit/codex-responses-header-passthrough.test.js unit/codex-fast-capacity.test.js
cd .. && npx eslint src/lib/codexConfig.js src/app/api/cli-tools/codex-settings/route.js 'src/app/(dashboard)/dashboard/cli-tools/components/CodexToolCard.js'
git diff --check HEAD~4..HEAD
git status --short
```

Expected: selected tests PASS, ESLint exits 0, diff check has no output, and the
working tree is clean.

- [ ] **Step 2: Verify commit and repository scope**

```bash
git log --oneline -6
git show --stat --oneline HEAD~4..HEAD
```

Expected: commits are limited to the approved 9Router Codex configuration fix,
tests, changelog, spec, and plan. No `system-observer` file is changed.
