# Codex Subagent Metadata Passthrough Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Forward an explicit set of Codex turn metadata headers through native Responses transports so encrypted subagent tasks execute and return a non-empty result.

**Architecture:** Keep the allowlist as pure configuration, isolate case-insensitive header selection in a small utility, and integrate it only in `DefaultExecutor.buildHeaders()` when the resolved upstream is native `openai-responses`. Provider authentication remains authoritative because it is applied after the selected client metadata.

**Tech Stack:** JavaScript ESM, Fetch-compatible HTTP headers, Vitest, ESLint, Codex CLI 0.145.0, Docker.

---

## File Structure

- Create `open-sse/config/codexHeaders.js`: immutable allowlist of Codex Responses metadata header names.
- Create `open-sse/utils/codexHeaders.js`: pure case-insensitive selection helper with no provider or credential logic.
- Modify `open-sse/executors/default.js`: detect native Responses transports and merge selected metadata before router authentication.
- Create `tests/unit/codex-responses-header-passthrough.test.js`: security, transport scoping, and body-continuity regression coverage.
- Update `CHANGELOG.md`: record the Codex subagent compatibility fix.

### Task 1: Define the failing regression suite

**Files:**
- Create: `tests/unit/codex-responses-header-passthrough.test.js`
- Reference: `open-sse/executors/default.js`
- Reference: `open-sse/translator/index.js`

- [ ] **Step 1: Write the failing executor and continuity tests**

Create `tests/unit/codex-responses-header-passthrough.test.js` with:

```js
import { describe, expect, it } from "vitest";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { translateRequest } from "../../open-sse/translator/index.js";

const CODEX_HEADERS = {
  originator: "codex_cli_rs",
  "session-id": "session-child",
  "thread-id": "thread-child",
  "User-Agent": "codex_cli_rs/0.145.0",
  "X-Client-Request-Id": "request-child",
  "X-Codex-Beta-Features": "remote_compaction_v2",
  "X-Codex-Turn-Metadata": JSON.stringify({
    request_kind: "turn",
    thread_source: "subagent",
  }),
  "X-Codex-Window-Id": "thread-child:0",
  "X-OpenAI-Internal-Codex-Responses-Lite": "true",
};

const SENSITIVE_HEADERS = {
  Authorization: "Bearer client-secret",
  Cookie: "session=client-secret",
  "X-Api-Key": "client-secret",
  Host: "attacker.example",
  "Content-Length": "999",
  "X-Forwarded-For": "203.0.113.7",
  "X-Unreviewed-Metadata": "must-not-pass",
};

describe("Codex Responses metadata passthrough", () => {
  it("forwards only allowlisted metadata to dynamic Responses providers", () => {
    const executor = new DefaultExecutor("openai-compatible-responses-test");
    const headers = executor.buildHeaders({
      apiKey: "router-secret",
      rawHeaders: { ...CODEX_HEADERS, ...SENSITIVE_HEADERS },
    }, true);

    expect(headers).toMatchObject({
      originator: "codex_cli_rs",
      "session-id": "session-child",
      "thread-id": "thread-child",
      "user-agent": "codex_cli_rs/0.145.0",
      "x-client-request-id": "request-child",
      "x-codex-beta-features": "remote_compaction_v2",
      "x-codex-turn-metadata": CODEX_HEADERS["X-Codex-Turn-Metadata"],
      "x-codex-window-id": "thread-child:0",
      "x-openai-internal-codex-responses-lite": "true",
      Authorization: "Bearer router-secret",
      Accept: "text/event-stream",
    });
    expect(headers).not.toHaveProperty("cookie");
    expect(headers).not.toHaveProperty("x-api-key");
    expect(headers).not.toHaveProperty("host");
    expect(headers).not.toHaveProperty("content-length");
    expect(headers).not.toHaveProperty("x-forwarded-for");
    expect(headers).not.toHaveProperty("x-unreviewed-metadata");
  });

  it("forwards metadata for an explicitly resolved Responses transport", () => {
    const executor = new DefaultExecutor("openai");
    const headers = executor.buildHeaders({
      apiKey: "router-secret",
      rawHeaders: CODEX_HEADERS,
      runtimeTransport: {
        format: FORMATS.OPENAI_RESPONSES,
        headers: { "User-Agent": "router-default" },
      },
    }, true);

    expect(headers["x-codex-turn-metadata"]).toBe(
      CODEX_HEADERS["X-Codex-Turn-Metadata"],
    );
    expect(headers["user-agent"]).toBe("codex_cli_rs/0.145.0");
    expect(Object.keys(headers).filter(name => name.toLowerCase() === "user-agent"))
      .toEqual(["user-agent"]);
  });

  it("does not forward Codex metadata to Chat Completions transports", () => {
    const executor = new DefaultExecutor("openai-compatible-test");
    const headers = executor.buildHeaders({
      apiKey: "router-secret",
      rawHeaders: CODEX_HEADERS,
    }, true);

    expect(headers).not.toHaveProperty("x-codex-turn-metadata");
    expect(headers).not.toHaveProperty("session-id");
    expect(headers.Authorization).toBe("Bearer router-secret");
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

    const result = translateRequest(
      FORMATS.OPENAI_RESPONSES,
      FORMATS.OPENAI_RESPONSES,
      body.model,
      body,
      true,
      null,
      "openai-compatible-responses-test",
    );

    expect(result.input).toEqual([agentMessage]);
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd tests
npx vitest run unit/codex-responses-header-passthrough.test.js --reporter=verbose
```

Expected: the encrypted body continuity and Chat Completions isolation tests pass,
while the two Responses forwarding tests fail because
`DefaultExecutor.buildHeaders()` does not yet select client metadata.

- [ ] **Step 3: Commit the regression test**

```bash
git add tests/unit/codex-responses-header-passthrough.test.js
git commit -m "test(codex): reproduce missing subagent metadata"
```

### Task 2: Add the allowlist and pure selection helper

**Files:**
- Create: `open-sse/config/codexHeaders.js`
- Create: `open-sse/utils/codexHeaders.js`
- Test: `tests/unit/codex-responses-header-passthrough.test.js`

- [ ] **Step 1: Add the immutable configuration allowlist**

Create `open-sse/config/codexHeaders.js`:

```js
export const CODEX_RESPONSES_PASSTHROUGH_HEADERS = Object.freeze([
  "originator",
  "session-id",
  "thread-id",
  "user-agent",
  "x-client-request-id",
  "x-codex-beta-features",
  "x-codex-turn-metadata",
  "x-codex-window-id",
  "x-openai-internal-codex-responses-lite",
]);
```

- [ ] **Step 2: Add the case-insensitive pure selector**

Create `open-sse/utils/codexHeaders.js`:

```js
import { CODEX_RESPONSES_PASSTHROUGH_HEADERS } from "../config/codexHeaders.js";

const CODEX_HEADER_SET = new Set(CODEX_RESPONSES_PASSTHROUGH_HEADERS);

export function selectCodexResponsesHeaders(rawHeaders) {
  if (!rawHeaders || typeof rawHeaders !== "object") return {};

  const selected = {};
  for (const [rawName, rawValue] of Object.entries(rawHeaders)) {
    const name = String(rawName).toLowerCase();
    if (!CODEX_HEADER_SET.has(name) || rawValue == null || rawValue === "") continue;
    selected[name] = Array.isArray(rawValue) ? rawValue.join(", ") : String(rawValue);
  }
  return selected;
}

export function mergeCodexResponsesHeaders(baseHeaders, rawHeaders) {
  const merged = { ...baseHeaders };
  const selected = selectCodexResponsesHeaders(rawHeaders);

  for (const [name, value] of Object.entries(selected)) {
    for (const existingName of Object.keys(merged)) {
      if (existingName.toLowerCase() === name) delete merged[existingName];
    }
    merged[name] = value;
  }
  return merged;
}
```

- [ ] **Step 3: Add direct selector assertions to the existing test file**

Add this import:

```js
import { selectCodexResponsesHeaders } from "../../open-sse/utils/codexHeaders.js";
```

Add this test before the executor tests:

```js
it("selects allowlisted headers case-insensitively without mutating input", () => {
  const rawHeaders = { ...CODEX_HEADERS, ...SENSITIVE_HEADERS };
  const snapshot = structuredClone(rawHeaders);

  const selected = selectCodexResponsesHeaders(rawHeaders);

  expect(selected["x-codex-turn-metadata"]).toBe(
    CODEX_HEADERS["X-Codex-Turn-Metadata"],
  );
  expect(selected["user-agent"]).toBe("codex_cli_rs/0.145.0");
  expect(selected).not.toHaveProperty("authorization");
  expect(selected).not.toHaveProperty("cookie");
  expect(selectCodexResponsesHeaders(null)).toEqual({});
  expect(rawHeaders).toEqual(snapshot);
});
```

- [ ] **Step 4: Run the test and verify the selector is GREEN while integration stays RED**

Run:

```bash
cd tests
npx vitest run unit/codex-responses-header-passthrough.test.js --reporter=verbose
```

Expected: selector and encrypted body tests pass; executor forwarding tests still fail.

- [ ] **Step 5: Commit the helper boundary**

```bash
git add open-sse/config/codexHeaders.js open-sse/utils/codexHeaders.js tests/unit/codex-responses-header-passthrough.test.js
git commit -m "feat(codex): select safe Responses metadata"
```

### Task 3: Integrate metadata into native Responses executor headers

**Files:**
- Modify: `open-sse/executors/default.js:1-180`
- Test: `tests/unit/codex-responses-header-passthrough.test.js`

- [ ] **Step 1: Import the format constant and selection helper**

Add to `open-sse/executors/default.js`:

```js
import { FORMATS } from "../translator/formats.js";
import { mergeCodexResponsesHeaders } from "../utils/codexHeaders.js";
```

- [ ] **Step 2: Add native Responses transport detection**

Place this helper near the existing auth helpers:

```js
function usesNativeResponsesTransport(provider, config, credentials) {
  return credentials?.runtimeTransport?.format === FORMATS.OPENAI_RESPONSES ||
    config?.format === FORMATS.OPENAI_RESPONSES ||
    (provider?.startsWith?.("openai-compatible-") && provider.includes("responses"));
}
```

- [ ] **Step 3: Merge safe metadata before applying provider auth**

Replace the start of `DefaultExecutor.buildHeaders()` with:

```js
buildHeaders(credentials, stream = true) {
  const rt = credentials?.runtimeTransport;
  const baseHeaders = {
    "Content-Type": "application/json",
    ...(rt ? rt.headers : this.config.headers),
  };
  const headers = usesNativeResponsesTransport(this.provider, this.config, credentials)
    ? mergeCodexResponsesHeaders(baseHeaders, credentials?.rawHeaders)
    : baseHeaders;
  const desc = rt?.auth || AUTH_DESCRIPTORS[this.provider] || this.resolveAuthDescriptor();
  for (const hook of desc.hooks || []) HEADER_HOOKS[hook]?.(headers, credentials);
  applyAuth(headers, desc, credentials);
```

Keep the remaining Anthropic-compatible cleanup and `Accept` handling unchanged. Applying auth after `codexHeaders` guarantees that the router credential wins.

- [ ] **Step 4: Run the focused suite and verify GREEN**

Run:

```bash
cd tests
npx vitest run unit/codex-responses-header-passthrough.test.js --reporter=verbose
```

Expected: all five tests pass.

- [ ] **Step 5: Run adjacent executor and Responses regression tests**

Run:

```bash
cd tests
npx vitest run \
  unit/codex-responses-header-passthrough.test.js \
  unit/openai-responses-multiturn.test.js \
  unit/openai-responses-params.test.js \
  unit/request-detail-config.test.js \
  unit/responses-handler-request-detail.test.js \
  translator/golden-url-header.test.js \
  translator/thinking-unified.test.js \
  translator/bugs-codexCli-responses.test.js \
  --reporter=verbose
```

Expected: all non-catalogued tests pass; only explicitly expected failures remain.

- [ ] **Step 6: Run lint and whitespace checks**

Run:

```bash
npx eslint open-sse/config/codexHeaders.js open-sse/utils/codexHeaders.js open-sse/executors/default.js
git diff --check
```

Expected: both commands exit 0 without output.

- [ ] **Step 7: Commit executor integration**

```bash
git add open-sse/executors/default.js
git commit -m "fix(codex): forward subagent turn metadata"
```

### Task 4: Document and verify the fix end to end

**Files:**
- Modify: `CHANGELOG.md`
- Verify: `docs/superpowers/specs/2026-07-24-codex-subagent-metadata-passthrough-design.md`
- Verify: `docs/superpowers/plans/2026-07-24-codex-subagent-metadata-passthrough.md`

- [ ] **Step 1: Add a changelog entry**

Under `# v0.5.40 (2026-07-20)` → `## Fixes` in `CHANGELOG.md`, add:

```markdown
- **Codex**: fix subagents returning empty results through native Responses connections by safely forwarding allowlisted turn metadata without forwarding client credentials.
```

- [ ] **Step 2: Build an isolated verification image**

Run:

```bash
docker build -t 9router:codex-subagent-metadata-test .
```

Expected: image build completes successfully.

- [ ] **Step 3: Copy runtime data into an isolated named Docker volume**

Run:

```bash
docker volume create router9-codex-e2e-data
docker run --rm \
  -v /home/marverlous/service/9router/data/9router:/source:ro \
  -v router9-codex-e2e-data:/target \
  alpine:3.20 sh -c 'cp -a /source/. /target/'
```

Expected: Docker prints `router9-codex-e2e-data`; the copy command exits 0
without printing secret contents. The production bind mount remains read-only
inside the copy container.

- [ ] **Step 4: Start the patched router on an isolated port**

Run:

```bash
docker run -d --name router9-codex-e2e \
  -p 127.0.0.1:20129:20128 \
  -e DATA_DIR=/app/data \
  -e PORT=20128 \
  -e HOSTNAME=0.0.0.0 \
  -e NODE_ENV=production \
  -v router9-codex-e2e-data:/app/data \
  9router:codex-subagent-metadata-test
```

Expected: Docker prints the new container ID and leaves the production `router9` container untouched.

- [ ] **Step 5: Run a real Codex subagent probe through the isolated router**

Run:

```bash
codex exec --ephemeral \
  -C /home/marverlous/workspace/opensource/9router \
  -c 'model_provider="9router"' \
  -c 'model_providers.9router.base_url="http://127.0.0.1:20129/v1"' \
  -m 'lumi/gpt-5.6-terra' \
  'Spawn exactly one subagent with fork_turns="none". Give it this task: run pwd with a read-only shell tool, then return exactly SUBAGENT_METADATA_OK followed by the working directory. Wait for it and include its non-empty result in your final answer.'
```

Expected: the child calls a shell tool, returns `SUBAGENT_METADATA_OK`, and the parent includes that non-empty result. `docker logs router9-codex-e2e` must show non-zero input/output usage for the seven-item child request instead of `IN 0 · OUT 0`.

- [ ] **Step 6: Stop and remove only the isolated verification container**

Run:

```bash
docker stop router9-codex-e2e
docker rm router9-codex-e2e
```

Expected: both commands name `router9-codex-e2e`; the production container remains running.

Remove only the explicit isolated volume after the container is gone:

```bash
docker volume rm router9-codex-e2e-data
```

Expected: Docker prints `router9-codex-e2e-data`. The production bind-mounted
data remains untouched.

- [ ] **Step 7: Run final verification**

Run:

```bash
cd tests
npx vitest run \
  unit/codex-responses-header-passthrough.test.js \
  unit/openai-responses-multiturn.test.js \
  unit/openai-responses-params.test.js \
  unit/request-detail-config.test.js \
  unit/responses-handler-request-detail.test.js \
  translator/golden-url-header.test.js \
  translator/thinking-unified.test.js \
  translator/bugs-codexCli-responses.test.js \
  --reporter=verbose
cd ..
npx eslint open-sse/config/codexHeaders.js open-sse/utils/codexHeaders.js open-sse/executors/default.js
git diff --check origin/main...HEAD
git status --short
```

Expected: focused tests pass apart from catalogued expected failures, ESLint and diff checks exit 0, and the worktree contains only the intended changelog/plan state.

- [ ] **Step 8: Commit documentation and verification record**

```bash
git add CHANGELOG.md
git commit -m "docs: record Codex subagent metadata fix"
```

- [ ] **Step 9: Push the reviewed implementation to the existing draft PR**

```bash
git push origin fix/open-ai-reasoning
gh pr view 1 --repo marverlous811/9router --json url,isDraft,baseRefName,headRefName,commits
```

Expected: PR `https://github.com/marverlous811/9router/pull/1` remains a draft with base `main` and includes the new test, implementation, changelog, and plan commits.
