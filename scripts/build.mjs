// Pre-transform src/tui.tsx into plain JS for the npm package.
//
// OpenCode compiles plugin TSX at load time with babel-preset-solid, but its
// transform deliberately skips anything under node_modules, so an npm package
// has to ship the transformed output. These are the same preset options the
// host uses for file plugins (@opentui/solid universal renderer).
import { transformFileAsync } from "@babel/core"
import { mkdirSync, writeFileSync } from "node:fs"

const result = await transformFileAsync("src/tui.tsx", {
  babelrc: false,
  configFile: false,
  presets: [
    ["babel-preset-solid", { moduleName: "@opentui/solid", generate: "universal" }],
    ["@babel/preset-typescript", {}],
  ],
})
if (!result?.code) throw new Error("babel produced no output")
mkdirSync("dist", { recursive: true })
writeFileSync("dist/tui.js", result.code + "\n")
console.log(`dist/tui.js: ${result.code.split("\n").length} lines`)
