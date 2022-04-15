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
  const jungle = getConfig({
    name: "jungle",
    entry: {
      jungle: "./src/jungle.peggy",
    },
    module: {
      rules: [
        {
          test: /\.peggy$/,
          // Set the type so that the raw .js file is generated
          type: "asset/resource",
          use: [{ loader: path.resolve(__dirname, "src/peggy-loader.cjs") }],
          generator: {
            // name the raw .js file
            filename: "[name].js",
          },
        },
      ],
    },
    plugins: [
      {
        /*
         * Probably overthinking this. I want "webpack watch" to work,
         * so I want the parser generation to be part of the build.
         * My previous attempt worked, but we ended up generating the
         * parser twice (once as part of the main library, and once
         * standalone), and since peggy doesn't generate SourceMaps,
         * there was nothing for the generated .js code to refer back
         * to.
         *
         * So I wanted to just generate the standalone file,
         * and use it as an input to the main library.
         * So it has to happen in a separate, dependent config.
         *
         * So far, so good... but Peggy generates a perfectly good es
         * module, which peg.js could import - but webpack insists on
         * converting it to commonjs. This isn't really a problem, but
         * I'd prefer to have the SourceMap refer back to a clean es
         * module, rather than the webpackified version.
         *
         * If I mark it "asset/resource" it will at least generate both
         * the raw output of peggy, and the "wrapped" version. But now
         * I also have an unwanted .cjs version. I use the following
         * plugin to remove that from the build before it's emitted.
         *
         * There has to be a better way...
         */
        apply(compiler) {
          const pluginName = "Assets Plugin";
          compiler.hooks.compilation.tap(pluginName, function (compilation) {
            compilation.hooks.processAssets.tap(
              {
                name: pluginName,
                stage:
                  compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_PRE_PROCESS,
                additionalAssets: false,
              },
              function (assets) {
                Object.keys(assets).forEach((file) => {
                  if (/\.cjs$/.test(file)) {
                    compilation.deleteAsset(file);
                  }
                });
              }
            );
          });
        },
      },
    ],

    devtool: false,
  });

  const optimizer = getConfig({
    name: "monkeyc-optimizer",
    entry: {
      optimizer: "./src/optimizer.js",
    },
    optimization: { minimize: false },
    dependencies: ["jungle"],
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
      stream: "stream",
      string_decoder: "string_decoder",
      timers: "timers",
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

  return [jungle, optimizer];
};
