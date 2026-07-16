/**
 * Compiles atop into a single self-contained binary at dist/atop.
 *
 * ink statically references `react-devtools-core` from its devtools module,
 * which is only ever loaded when `process.env.DEV === "true"`. We stub it at
 * bundle time so the compiled binary neither needs the package nor drags in
 * its dependency tree.
 */
import { rmSync } from "node:fs";

rmSync("dist/atop", { force: true });

const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  compile: { outfile: "dist/atop" },
  plugins: [
    {
      name: "stub-react-devtools-core",
      setup(build) {
        build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
          path: "react-devtools-core",
          namespace: "stub-devtools",
        }));
        build.onLoad({ filter: /.*/, namespace: "stub-devtools" }, () => ({
          contents: "export default { connectToDevTools() {}, initialize() {} };",
          loader: "js",
        }));
      },
    },
  ],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log("built dist/atop");
