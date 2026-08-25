import { cpSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const NATIVE_CODEX_WS_ASSETS = [
  "codex-websocket-loader.mjs",
  "src",
  "open-sse",
];

const NATIVE_CODEX_WS_MODULES = [
  "confbox",
  "https-proxy-agent",
  "jose",
  "node-machine-id",
  "socks-proxy-agent",
  "undici",
  "uuid",
  "ws",
];

function copyModuleIfMissing(projectRoot, standaloneDir, moduleName) {
  const destination = resolve(standaloneDir, "node_modules", moduleName);
  if (existsSync(destination)) return;

  const source = resolve(projectRoot, "node_modules", moduleName);
  if (!existsSync(source)) {
    console.warn(`[standalone-assets] Native Codex WebSocket dependency is unavailable: ${moduleName}`);
    return;
  }

  cpSync(source, destination, { recursive: true, force: true });
  console.log(`[standalone-assets] Copied ${moduleName} to standalone node_modules`);
}

function copyModuleDependencyTree(projectRoot, standaloneDir, moduleName, copied = new Set()) {
  if (copied.has(moduleName)) return;
  copied.add(moduleName);
  copyModuleIfMissing(projectRoot, standaloneDir, moduleName);

  const manifestPath = resolve(projectRoot, "node_modules", moduleName, "package.json");
  if (!existsSync(manifestPath)) return;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const dependencyName of Object.keys(manifest.dependencies || {})) {
    copyModuleDependencyTree(projectRoot, standaloneDir, dependencyName, copied);
  }
}

export function copyStandaloneAssets({ projectRoot = process.cwd(), distDir = process.env.NEXT_DIST_DIR || ".next" } = {}) {
  if (process.env.NEXT_TRACING_ROOT_MODE === "workspace") {
    console.log("[standalone-assets] Skipping workspace-traced CLI build; CLI packaging handles assets");
    return;
  }

  const buildDir = resolve(projectRoot, distDir);
  const standaloneDir = resolve(buildDir, "standalone");

  if (!existsSync(standaloneDir)) {
    console.log(`[standalone-assets] No standalone build found at ${standaloneDir}`);
    return;
  }

  const staticSource = resolve(buildDir, "static");
  const staticDestination = resolve(standaloneDir, distDir, "static");
  if (existsSync(staticSource)) {
    cpSync(staticSource, staticDestination, { recursive: true, force: true });
    console.log(`[standalone-assets] Copied static assets to ${staticDestination}`);
  }

  const publicSource = resolve(projectRoot, "public");
  const publicDestination = resolve(standaloneDir, "public");
  if (existsSync(publicSource)) {
    cpSync(publicSource, publicDestination, { recursive: true, force: true });
    console.log(`[standalone-assets] Copied public assets to ${publicDestination}`);
  }

  // Without it beside server.js the standalone build serves requests unsanitized.
  const serverWrapperSource = resolve(projectRoot, "custom-server.js");
  const serverWrapperDestination = resolve(standaloneDir, "custom-server.js");
  if (existsSync(serverWrapperSource)) {
    cpSync(serverWrapperSource, serverWrapperDestination, { force: true });
    console.log(`[standalone-assets] Copied custom-server.js to ${serverWrapperDestination}`);
  }

  for (const asset of NATIVE_CODEX_WS_ASSETS) {
    const source = resolve(projectRoot, asset);
    const destination = resolve(standaloneDir, asset);
    if (!existsSync(source)) {
      console.warn(`[standalone-assets] Native Codex WebSocket asset is unavailable: ${asset}`);
      continue;
    }
    cpSync(source, destination, { recursive: true, force: true });
    console.log(`[standalone-assets] Copied ${asset} to standalone output`);
  }

  const copiedModules = new Set();
  for (const moduleName of NATIVE_CODEX_WS_MODULES) {
    copyModuleDependencyTree(projectRoot, standaloneDir, moduleName, copiedModules);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(dirname(fileURLToPath(import.meta.url)), "copy-standalone-assets.mjs")) {
  copyStandaloneAssets();
}
