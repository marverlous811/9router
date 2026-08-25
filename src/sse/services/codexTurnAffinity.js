import { createHash } from "node:crypto";

const MAX_TURN_STATE_LENGTH = 4096;
const MAX_AFFINITIES = 5000;
const TURN_AFFINITY_TTL_MS = 30 * 60_000;

const affinities = new Map();

function normalizeTurnState(value) {
  if (typeof value !== "string") return null;
  const turnState = value.trim();
  return turnState && turnState.length <= MAX_TURN_STATE_LENGTH ? turnState : null;
}

function clientScope(apiKey) {
  if (!apiKey) return "local";
  return createHash("sha256").update(String(apiKey)).digest("hex");
}

function affinityKey(turnState, apiKey) {
  const normalized = normalizeTurnState(turnState);
  return normalized ? `${clientScope(apiKey)}:${normalized}` : null;
}

function removeExpired(now = Date.now()) {
  for (const [key, entry] of affinities) {
    if (now - entry.lastUsedAt > TURN_AFFINITY_TTL_MS) affinities.delete(key);
  }
}

function touch(key, entry) {
  entry.lastUsedAt = Date.now();
  affinities.delete(key);
  affinities.set(key, entry);
  return entry;
}

const cleanupTimer = setInterval(removeExpired, TURN_AFFINITY_TTL_MS);
cleanupTimer.unref?.();

export function getCodexTurnAffinity({ turnState, apiKey, provider, model } = {}) {
  removeExpired();
  const key = affinityKey(turnState, apiKey);
  if (!key) return null;

  const entry = affinities.get(key);
  if (!entry) return null;
  if (entry.provider !== provider || entry.model !== model) return null;
  return { ...touch(key, entry) };
}

export function setCodexTurnAffinity({ turnState, apiKey, provider, model, connectionId } = {}) {
  const key = affinityKey(turnState, apiKey);
  if (!key || !provider || !model || !connectionId) return null;

  removeExpired();
  if (!affinities.has(key) && affinities.size >= MAX_AFFINITIES) {
    affinities.delete(affinities.keys().next().value);
  }

  return {
    ...touch(key, { provider, model, connectionId, lastUsedAt: Date.now() }),
  };
}

export function clearCodexTurnAffinity({ turnState, apiKey } = {}) {
  const key = affinityKey(turnState, apiKey);
  return key ? affinities.delete(key) : false;
}

export function isCodexTurnStateOwnerUnavailable(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /turn-state owner account is unavailable/i.test(message);
}

export function createTurnStateOwnerUnavailableError(message = "Turn-state owner account is unavailable; retry the logical turn.") {
  return Object.assign(new Error(message), {
    status: 409,
    code: "turn_state_owner_unavailable",
    type: "invalid_request_error",
  });
}

export const __test__ = {
  clear: () => affinities.clear(),
  normalizeTurnState,
  removeExpired,
};
