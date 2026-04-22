import { readFileSync } from "node:fs";

import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync("./package.json", "utf8")) as { version: string };

export default defineConfig({
  entry: { "bin/gistjet": "src/bin/gistjet.ts" },
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  platform: "node",
  banner: { js: "#!/usr/bin/env node" },
  clean: true,
  sourcemap: true,
  splitting: false,
  shims: false,
  define: { __GISTJET_VERSION__: JSON.stringify(version) },
});
