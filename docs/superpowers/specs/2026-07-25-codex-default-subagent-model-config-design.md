# Codex Default Subagent Model Configuration Design

## Context

The 9Router Codex dashboard currently writes this section to
`~/.codex/config.toml`:

```toml
[agents.subagent]
model = "lumi/gpt-5.6-terra"
```

Codex CLI 0.145.0 does not use that section for its default spawned-agent
model. The current configuration contract places the setting directly under
`[agents]` as `default_subagent_model`.

Custom agent files under `.codex/agents/*.toml` are separate from this global
fallback. When Codex selects a custom role through `agent_type`, the `model` in
that agent file takes precedence. This change does not alter or generate custom
agent files.

Session evidence from `system-observer` also confirmed that 9Router routing is
not responsible for custom-role selection: a child spawned with
`agent_type = "planner"` used `lumi/gpt-5.6-terra`, while children spawned
without a role selector inherited the main `lumi/gpt-5.6-sol` model before the
request reached 9Router.

## Goal

Make the 9Router Codex settings UI read, write, display, and reset the current
Codex default subagent model setting without disturbing unrelated TOML
configuration.

## Non-goals

- Selecting a custom Codex agent role at spawn time.
- Editing `.codex/agents/*.toml` files.
- Implementing Claude Code orchestration behavior.
- Inferring an agent role from request headers, task names, or model aliases.
- Changing gateway routing, provider selection, or model alias resolution.
- Migrating arbitrary historical Codex configuration beyond the obsolete
  9Router-owned `[agents.subagent]` entry.

The cross-runtime orchestration work is tracked separately in
`marverlous811/shadow-ai-workflow#1`.

## Chosen Approach

Use the official Codex global setting:

```toml
[agents]
default_subagent_model = "lumi/gpt-5.6-terra"
```

Extract the TOML transformation into a small pure helper. The API route will
handle filesystem and HTTP concerns while the helper owns parsing-compatible
object updates. This keeps merge and reset behavior directly testable without
writing to the real user home directory.

## Components

### Codex configuration helper

Add a helper under `src/lib/` that operates on the object returned by
`confbox`:

- apply the main model and 9Router provider settings;
- set `agents.default_subagent_model`;
- remove the obsolete 9Router-generated `agents.subagent` table;
- preserve all unrelated root keys, provider entries, and `[agents]` fields;
- reset only the 9Router-owned model/provider/default-subagent fields and the
  obsolete `agents.subagent` entry;
- remove empty containers created by cleanup where practical.

The helper must not read or write files and must not mutate caller-owned input.

### Codex settings API

The API route will continue validating `baseUrl`, `apiKey`, and `model`,
normalizing the `/v1` suffix, and maintaining `auth.json`. It will delegate
TOML object changes to the pure helper before serializing the result.

When no explicit subagent model is supplied, the API will use the selected main
model as the default, preserving the current dashboard behavior.

### Codex dashboard card

The card will parse `default_subagent_model` from `[agents]` instead of looking
for `[agents.subagent] model`. The manual configuration preview will show the
same current schema used by the API.

The UI label remains “Subagent Model” because it configures the fallback for
spawned agents. Custom agent files can still override it.

## Data Flow

1. The user selects a main model and optional subagent fallback model.
2. The dashboard POSTs both values to the Codex settings endpoint.
3. The endpoint parses the existing TOML.
4. The helper merges 9Router settings and sets
   `agents.default_subagent_model` while preserving unrelated values.
5. The endpoint serializes and writes `config.toml`, then updates `auth.json`.
6. A later GET returns the raw config and the card reads the current fallback.
7. Reset removes only the settings owned by this integration and leaves other
   Codex agent limits or flags intact.

## Compatibility and Migration

Applying settings will migrate an obsolete 9Router-generated
`[agents.subagent]` entry to `agents.default_subagent_model`. The selected value
from the current request is authoritative.

Reset will remove both the current key and the obsolete table so stale
9Router-generated configuration does not remain active or misleading.

Existing custom agent files are untouched. A custom agent selected by Codex
continues to use its own model; an unnamed or default child uses
`default_subagent_model`.

## Error Handling

- Invalid required POST input continues to return HTTP 400.
- Missing configuration or authentication files remain non-errors.
- Parse, serialization, or filesystem failures continue to return HTTP 500
  without partially changing unrelated in-memory configuration.
- The transformation must not silently discard unknown TOML fields.

## Testing

Write failing unit tests before production changes. Tests must prove that:

- applying settings writes `agents.default_subagent_model`;
- an explicit subagent model differs from and is independent of the main model;
- omitting the subagent model falls back to the main model;
- existing `[agents]` fields such as concurrency limits and interrupt settings
  survive apply and reset;
- unrelated root and provider configuration survives apply and reset;
- obsolete `agents.subagent` configuration is removed;
- reset removes the current default subagent key without deleting other
  `[agents]` settings;
- transformations do not mutate their inputs;
- the manual configuration preview uses the current schema.

Run the focused Vitest file, relevant Codex settings tests, ESLint on changed
files, and `git diff --check`. A live Codex probe may confirm the default-child
fallback, but custom-role selection is outside this change and is already
tracked separately.

## Rollback

Rollback restores the previous API/card transformation and manual preview. No
database migration is involved. Applying settings again with a corrected build
rewrites the TOML to whichever schema that build supports.
