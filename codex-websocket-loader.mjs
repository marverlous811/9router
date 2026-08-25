import { resolve as resolvePath } from "node:path";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

let projectRoot = pathToFileURL(`${process.cwd()}/`);

export function initialize(data) {
  if (data?.projectRoot) projectRoot = new URL(data.projectRoot);
}

function resolveFile(pathname) {
  const candidates = [
    pathname,
    `${pathname}.js`,
    `${pathname}.mjs`,
    `${pathname}.cjs`,
    `${pathname}/index.js`,
  ];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function resolveProjectSpecifier(specifier) {
  let relativePath;
  if (specifier.startsWith("@/")) {
    relativePath = `src/${specifier.slice(2)}`;
  } else if (specifier === "open-sse") {
    relativePath = "open-sse/index.js";
  } else if (specifier.startsWith("open-sse/")) {
    relativePath = `open-sse/${specifier.slice("open-sse/".length)}`;
  } else {
    return null;
  }

  const rootPath = fileURLToPath(projectRoot);
  const candidate = resolvePath(rootPath, relativePath);
  const resolved = resolveFile(candidate);
  return resolved ? pathToFileURL(resolved).href : null;
}

export function resolve(specifier, context, nextResolve) {
  const url = resolveProjectSpecifier(specifier);
  if (url) return { url, shortCircuit: true };
  return nextResolve(specifier, context);
}
