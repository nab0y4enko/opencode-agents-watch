#!/usr/bin/env bun
// Compiles src/gui.tsx -> dist/gui-experimental.cjs for the OpenCode desktop app.
//
// The app evaluates the bundle as CommonJS text and hands it its own instances
// of the modules below, so they stay external (bundling a copy of solid-js
// would give the plugin a second, disconnected reactive runtime). This mirrors
// `gui()` from `@opencode/plugin/gui/vite` without needing Vite: Babel compiles
// Solid's DOM JSX, Bun bundles the rest.
import { transformAsync } from "@babel/core"
import ts from "@babel/preset-typescript"
import solid from "babel-preset-solid"

// pluginSharedModules + pluginWindowModules from @opencode/plugin/gui/modules.
const PROVIDED = [
  "effect",
  "@opencode/plugin/gui",
  "@opencode/plugin/gui/main",
  "@opencode/plugin/rpc",
  "@opencode/schema/rpc",
  "@opencode/client",
  "@opencode/client/effect",
  "solid-js",
  "solid-js/web",
  "solid-js/store",
  "@opencode/plugin/gui/file",
  "@opencode/plugin/gui/review",
  "@opencode/plugin/gui/browser",
  "@opencode/client/solid",
]

const solidDom = {
  name: "solid-dom",
  setup(build) {
    build.onLoad({ filter: /[/\\]src[/\\].*\.tsx$/ }, async (args) => {
      const code = await Bun.file(args.path).text()
      const result = await transformAsync(code, {
        filename: args.path,
        babelrc: false,
        configFile: false,
        presets: [[solid, { generate: "dom", moduleName: "solid-js/web" }], [ts, { isTSX: true, allExtensions: true }]],
      })
      return { contents: result?.code ?? "", loader: "js" }
    })
  },
}

const result = await Bun.build({
  entrypoints: ["./src/gui.tsx"],
  outdir: "./dist",
  naming: "gui-experimental.cjs",
  format: "cjs",
  target: "browser",
  minify: false,
  plugins: [solidDom],
  external: PROVIDED,
})

if (!result.success) {
  console.error(result.logs)
  process.exit(1)
}
console.log("built:", result.outputs.map((o) => o.path))
