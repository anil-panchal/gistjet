import { defineConfig } from "tsup";

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
});
