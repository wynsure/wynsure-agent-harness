import { defineConfig } from "tsup"

/**
 * Bundles the harness public surface (src/index.ts barrel) into a single
 * minified ESM file, plus a single rolled-up declaration file.
 *
 * Dependencies stay external (consumed from node_modules), matching the
 * `exports` field in package.json. The declaration file is renamed to
 * `dist/types.d.ts` by a post-build step in the `build` npm script, because
 * tsup runs the JS bundle and the DTS rollup concurrently so its `onSuccess`
 * hook may fire before `index.d.ts` is written.
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2022",
  platform: "node",
  minify: true,
  clean: true,
  dts: {
    // tsup forces `baseUrl` for declaration resolution; TypeScript 6.0 rejects
    // the deprecated `baseUrl` (TS5101) unless this is acknowledged.
    compilerOptions: { ignoreDeprecations: "6.0" },
  },
})

