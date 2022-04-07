/* eslint-env node */
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default (env, argv) => {
  function getConfig(extra) {
    const config = {
      mode: argv.mode || "development",
      performance: {
        hints: false,
      },
      output: {
        filename: "[name].cjs",
        path: path.resolve(__dirname, "build"),
        libraryTarget: "commonjs",
        devtoolModuleFilenameTemplate: "webpack://[resource-path]",
      },
      devtool: argv.mode != "production" ? "source-map" : false,
    };
    return { ...config, ...extra };
  }
  const optimizer = getConfig({
    name: "monkeyc-optimizer",
    entry: {
      optimizer: "./src/optimizer.js",
    },
    externals: {
      "prettier/standalone.js": "commonjs prettier/standalone.js",
      "@markw65/prettier-plugin-monkeyc":
        "commonjs @markw65/prettier-plugin-monkeyc",
      "fs/promises": "fs/promises",
      fs: "fs",
      path: "path",
      child_process: "child_process",
      readline: "readline",
      assert: "assert",
      util: "util",
    },
    plugins: [
      {
        apply(compiler) {
          const pluginName = "Log On Done Plugin";
          compiler.hooks.afterDone.tap(pluginName, () => {
            console.log(`\n[${new Date().toLocaleString()}] Build finished.\n`);
          });
        },
      },
    ],
  });

  return [optimizer];
};
