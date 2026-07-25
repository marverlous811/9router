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
