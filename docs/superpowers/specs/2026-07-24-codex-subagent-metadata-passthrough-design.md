# Codex Subagent Metadata Passthrough Design

## Problem

Codex CLI 0.145.0 can spawn a subagent through 9Router, but the child agent
finishes without tool calls or a final answer. The Responses request reaches
the upstream with HTTP 200, yet the upstream reports zero input and output
tokens.

The delegated task is represented as an `agent_message` item. Its routing
envelope is plaintext, while its payload is carried in an
`encrypted_content` block. Codex also sends turn-scoped HTTP metadata such as
`x-codex-turn-metadata`, `session-id`, and `thread-id`. Direct requests to the
configured Codex backend preserve those headers and subagents work. The native
Responses path through 9Router preserves the body but rebuilds upstream
headers, dropping the Codex metadata.

Telemetry fields such as `content: ""` and `user_input_count=0` are not proof
that Codex failed to create the task. The persisted child session and captured
request both contain the `agent_message` and its encrypted payload.

## Goal

Preserve the allowlisted Codex turn metadata required by native Responses
subagent workflows while keeping 9Router in control of upstream authentication
and transport headers.

Success requires all of the following:

- A Codex CLI child agent routed through a native Responses connection receives
  its delegated task.
- The child can call a tool and return a non-empty final answer to its parent.
- Client credentials and hop-by-hop headers are never forwarded upstream.
- Non-Responses providers and ordinary requests retain their current behavior.

## Non-goals

- Decrypting or rewriting `encrypted_content` inside 9Router.
- Supporting encrypted `agent_message` items through Chat Completions or other
  lossy format translations.
- Forwarding arbitrary client headers.
- Changing model routing, account fallback, or Codex CLI configuration.

## Chosen Approach

Use an explicit, case-insensitive allowlist for Codex metadata headers. Apply it
only to native OpenAI Responses transports. Merge the selected metadata into
the executor's upstream headers before applying 9Router's authorization so the
router-generated credential always wins.

The allowlist covers the headers observed on a current Codex Responses turn:

- `originator`
- `session-id`
- `thread-id`
- `user-agent`
- `x-client-request-id`
- `x-codex-beta-features`
- `x-codex-turn-metadata`
- `x-codex-window-id`
- `x-openai-internal-codex-responses-lite`

No prefix wildcard is permitted. New Codex headers must be reviewed and added
explicitly.

## Alternatives Considered

### Forward all headers except a denylist

This would require less maintenance when Codex adds metadata, but it risks
forwarding cookies, API keys, proxy headers, and unrelated client identity. A
denylist is unsafe because unknown sensitive headers fail open.

### Convert the delegated task to plaintext

9Router does not own the key for `encrypted_content`. Attempting to decrypt or
replace it is incompatible with the protocol and would couple the router to
private payload semantics.

### Leave the router unchanged and require direct Codex access

This is a workable temporary bypass, but it defeats the requested routing,
account selection, and usage tracking behavior.

## Components

### Header selection helper

A small pure helper accepts client headers and returns a new object containing
only allowlisted Codex metadata. It normalizes header names for matching,
ignores null or empty values, and never mutates the input.

The allowlist belongs in configuration/constants rather than being embedded in
executor control flow.

### Native Responses detection

Header passthrough is enabled only when the resolved upstream transport format
is `openai-responses`. This includes dynamic
`openai-compatible-responses-*` connections and other explicitly configured
native Responses transports. Chat Completions, Claude, Gemini, and translated
paths do not receive the metadata.

### Executor header merge

The Responses metadata is merged into the request headers before provider auth
is applied. 9Router continues to generate `Authorization`, `Content-Type`, and
`Accept`. Client values for those fields cannot enter the selected metadata
object and therefore cannot override router policy.

## Data Flow

1. Codex sends `/v1/responses` with an `agent_message` containing plaintext
   routing text and `encrypted_content`, plus turn metadata headers.
2. `src/sse/handlers/chat.js` captures the request body and lowercase headers in
   `clientRawRequest`.
3. `handleChatCore` resolves a native Responses transport and exposes the raw
   client headers to the executor through the request credentials context.
4. The executor selects only allowlisted Codex metadata and merges it into the
   upstream header set.
5. Provider authentication is applied last and the unchanged Responses body is
   sent upstream.
6. The upstream uses the preserved turn context to process the encrypted
   delegated task and streams the child result normally.

## Security and Error Handling

- The helper uses an allowlist, not a denylist or `x-*` wildcard.
- `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`,
  `host`, `content-length`, and forwarding headers are not selectable.
- Router-generated authentication has final precedence.
- Invalid or absent client metadata is ignored; normal provider requests remain
  functional.
- The encrypted task is never logged or transformed by the new code.
- Upstream errors retain the existing retry and fallback behavior.

## Testing

### Unit regression tests

Write tests before production changes and confirm they fail for the missing
behavior. Tests must prove that:

- all allowlisted Codex metadata is forwarded on a native Responses transport;
- header matching is case-insensitive;
- client authorization, cookies, API keys, host, content length, and arbitrary
  `x-*` headers are excluded;
- router-generated authorization overrides any client value;
- non-Responses transports do not receive Codex metadata;
- the request body retains the `agent_message` and `encrypted_content` block.

### Existing regression coverage

Run the focused executor/Responses tests, the Codex Responses translator tests,
ESLint on changed files, and `git diff --check`. Use the repository baseline
verifier if a broader suite is run because the checkout has known failures.

### End-to-end verification

Build and run the patched 9Router, then start Codex CLI with the `9router`
provider and a `lumi/*` native Responses model. Ask the main agent to spawn one
minimal child that must call a read-only tool and return a fixed non-empty
summary. Verify the child session, parent result, 9Router request log, and token
usage. The test passes only when the child sees the delegated instruction and
the parent receives its result without retrying into an empty completion.

## Rollback

The change is isolated to header selection for native Responses requests.
Rollback consists of removing the helper integration and its allowlist; no data
migration or configuration rollback is required.
