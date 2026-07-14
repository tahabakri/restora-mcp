import { build } from "esbuild";
import { chmodSync } from "node:fs";

// Single self-contained bundle (zod and everything else inlined) so the server runs with zero runtime
// deps — matches how @restora/cli ships. stdio JSON-RPC: stdout carries only protocol frames.
await build({
  entryPoints: ["bin/restora-mcp.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  outfile: "dist/restora-mcp.js",
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "info",
});

try {
  chmodSync("dist/restora-mcp.js", 0o755);
} catch {
  // chmod is a no-op / may fail on Windows — the shebang + bin mapping still work via npm.
}
console.log("Built dist/restora-mcp.js");
