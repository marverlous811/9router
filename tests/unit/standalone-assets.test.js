import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { copyStandaloneAssets } from "../../scripts/copy-standalone-assets.mjs";

function createBuildFixture(distDir) {
  const projectRoot = mkdtempSync(join(tmpdir(), "9router-standalone-assets-"));
  const buildRoot = join(projectRoot, distDir);
  mkdirSync(join(buildRoot, "standalone"), { recursive: true });
  mkdirSync(join(buildRoot, "static", "chunks"), { recursive: true });
  mkdirSync(join(projectRoot, "public"), { recursive: true });
  writeFileSync(join(buildRoot, "static", "chunks", "app.js"), "static asset");
  writeFileSync(join(projectRoot, "public", "favicon.svg"), "public asset");
  return projectRoot;
}

describe("standalone build assets", () => {
  it("copies static and public assets into the default standalone layout", () => {
    const projectRoot = createBuildFixture(".next");

    copyStandaloneAssets({ projectRoot, distDir: ".next" });

    expect(readFileSync(join(projectRoot, ".next", "standalone", ".next", "static", "chunks", "app.js"), "utf8"))
      .toBe("static asset");
    expect(readFileSync(join(projectRoot, ".next", "standalone", "public", "favicon.svg"), "utf8"))
      .toBe("public asset");
  });

  it("uses a custom Next dist directory", () => {
    const projectRoot = createBuildFixture(".next-cli-build");

    copyStandaloneAssets({ projectRoot, distDir: ".next-cli-build" });

    expect(readFileSync(join(projectRoot, ".next-cli-build", "standalone", ".next-cli-build", "static", "chunks", "app.js"), "utf8"))
      .toBe("static asset");
  });

  // Without the wrapper beside server.js nothing can prove a request is local.
  it("copies the request-sanitizing server wrapper into the standalone output", () => {
    const projectRoot = createBuildFixture(".next");
    writeFileSync(join(projectRoot, "custom-server.js"), "wrapper");

    copyStandaloneAssets({ projectRoot, distDir: ".next" });

    expect(readFileSync(join(projectRoot, ".next", "standalone", "custom-server.js"), "utf8"))
      .toBe("wrapper");
  });

  it("copies dynamically loaded Codex WebSocket assets and external modules", () => {
    const projectRoot = createBuildFixture(".next");
    writeFileSync(join(projectRoot, "codex-websocket-loader.mjs"), "loader");
    mkdirSync(join(projectRoot, "src", "sse", "services"), { recursive: true });
    mkdirSync(join(projectRoot, "open-sse", "utils"), { recursive: true });
    writeFileSync(join(projectRoot, "src", "sse", "services", "codexWebSocket.js"), "relay");
    writeFileSync(join(projectRoot, "open-sse", "utils", "codexHeaders.js"), "headers");
    for (const [moduleName, dependencies] of [
      ["confbox", {}],
      ["https-proxy-agent", { "agent-base": "*" }],
      ["jose", {}],
      ["node-machine-id", {}],
      ["socks-proxy-agent", { "agent-base": "*", socks: "*" }],
      ["undici", {}],
      ["uuid", {}],
      ["ws", {}],
      ["agent-base", { debug: "*" }],
      ["debug", {}],
      ["socks", {}],
    ]) {
      mkdirSync(join(projectRoot, "node_modules", moduleName), { recursive: true });
      writeFileSync(
        join(projectRoot, "node_modules", moduleName, "package.json"),
        JSON.stringify({ name: moduleName, dependencies }),
      );
    }

    copyStandaloneAssets({ projectRoot, distDir: ".next" });

    const standalone = join(projectRoot, ".next", "standalone");
    expect(readFileSync(join(standalone, "codex-websocket-loader.mjs"), "utf8")).toBe("loader");
    expect(readFileSync(join(standalone, "src", "sse", "services", "codexWebSocket.js"), "utf8")).toBe("relay");
    expect(readFileSync(join(standalone, "open-sse", "utils", "codexHeaders.js"), "utf8")).toBe("headers");
    for (const moduleName of ["confbox", "https-proxy-agent", "jose", "node-machine-id", "socks-proxy-agent", "undici", "uuid", "ws", "agent-base", "debug", "socks"]) {
      expect(JSON.parse(readFileSync(join(standalone, "node_modules", moduleName, "package.json"), "utf8")).name).toBe(moduleName);
    }
  });

  it("does not modify workspace-traced CLI builds", () => {
    const projectRoot = createBuildFixture(".next-cli-build");
    const previousMode = process.env.NEXT_TRACING_ROOT_MODE;
    process.env.NEXT_TRACING_ROOT_MODE = "workspace";

    try {
      copyStandaloneAssets({ projectRoot, distDir: ".next-cli-build" });
    } finally {
      if (previousMode === undefined) delete process.env.NEXT_TRACING_ROOT_MODE;
      else process.env.NEXT_TRACING_ROOT_MODE = previousMode;
    }

    expect(() => readFileSync(join(projectRoot, ".next-cli-build", "standalone", ".next-cli-build", "static", "chunks", "app.js")))
      .toThrow();
  });
});
