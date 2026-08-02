import { CODEX_RESPONSES_PASSTHROUGH_HEADERS } from "../config/codexHeaders.js";

const CODEX_RESPONSES_PASSTHROUGH_HEADER_SET = new Set(
  CODEX_RESPONSES_PASSTHROUGH_HEADERS,
);

export function selectCodexResponsesHeaders(rawHeaders) {
  if (rawHeaders === null || typeof rawHeaders !== "object") {
    return {};
  }

  const selectedHeaders = {};
  for (const [name, value] of Object.entries(rawHeaders)) {
    const canonicalName = name.toLowerCase();
    if (
      !CODEX_RESPONSES_PASSTHROUGH_HEADER_SET.has(canonicalName)
      || value === null
      || value === undefined
      || value === ""
    ) {
      continue;
    }

    selectedHeaders[canonicalName] = Array.isArray(value)
      ? value.join(", ")
      : String(value);
  }

  return selectedHeaders;
}

export function mergeCodexResponsesHeaders(baseHeaders, rawHeaders) {
  const mergedHeaders = { ...baseHeaders };
  const selectedHeaders = selectCodexResponsesHeaders(rawHeaders);

  for (const [selectedName, selectedValue] of Object.entries(selectedHeaders)) {
    for (const existingName of Object.keys(mergedHeaders)) {
      if (existingName.toLowerCase() === selectedName) {
        delete mergedHeaders[existingName];
      }
    }
    mergedHeaders[selectedName] = selectedValue;
  }

  return mergedHeaders;
}
