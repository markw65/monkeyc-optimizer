import peggyOptimizer from "@markw65/peggy-optimizer";
import { runBuild, startEndPlugin } from "@markw65/project-utils";
import glob from "fast-glob";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import peggy from "peggy";

const MONKEYC_OPTIMIZER = JSON.parse(await fs.readFile("./package.json"));

const esmDir = "build/esm";
const cjsDir = "build";

const cjsConfig = async (sourcemap) => {
  const files = await glob(`${esmDir}/**/*.js`);

  const entryPoints = files.map((file) => ({
    in: file,
    out: path.basename(file, ".js"),
  }));

  return {
    entryPoints,
    bundle: false,
    platform: "node",
    outdir: `${cjsDir}`,
    target: "node16.4",
    format: "cjs",
    outExtension: { ".js": ".cjs" },
    plugins: [fixImportsPlugin],
    sourcemap,
    sourcesContent: false,
    metafile: true,
    logLevel: "silent",
  };
};

const fixImportsPlugin = {
  name: "fix-imports",
  setup(build) {
    build.onLoad({ filter: /\.js$/ }, async (args) => {
      // Load the file from the file system
      const source = await fs.readFile(args.path, "utf8");
      const contents = source
        .replace(/((?:^|\s)(?:from|import)\s+".\/chunk-.*\.)(js")/g, "$1c$2")
        .replace("lastModifiedSource", Date.now().toString())
        // yauzl includes a library that has this. There are years-old
        // bug reports, so we'll just fix it here (otherwise we get
        // deprecation warnings)
        .replace("new Buffer(toRead)", "Buffer.alloc(toRead)");
      return { contents };
    });
  },
};

const peggyPlugin = {
  name: "peggy",
  setup(build) {
    build.onLoad({ filter: /\.peggy$/ }, async (args) => {
      // Load the file from the file system
      const source = await fs.readFile(args.path, "utf8");
      const convertMessage = ({ message, location: loc }) => {
        let location;
        if (loc) {
          const lineText = source.split(/\r\n|\r|\n/g)[loc.start.line - 1];
          const lineEnd =
            loc.start.line === loc.end.line ? loc.end.column : lineText.length;
          location = {
            file: args.path,
            line: loc.start.line,
            column: loc.start.column,
            length: lineEnd - loc.start.column,
            lineText,
          };
        }
        return { text: message, location };
      };

      try {
        const mapDir = path.resolve(build.initialOptions.outdir, "..");
        const options = /** @type {const} */ {
          cache: false,
          format: "es",
          grammarSource: args.path,
          plugins: [peggyOptimizer],
        };
        if (build.initialOptions.sourcemap) {
          const sourceAndMap = peggy
            .generate(source, {
              ...options,
              output: "source-and-map",
            })
            .toStringWithSourceMap({});
          let contents = sourceAndMap.code;
          const sourceMap = sourceAndMap.map.toJSON();
          sourceMap.sources = sourceMap.sources.map((src) => {
            return src === null ? null : path.relative(mapDir, src);
          });
          const map = `data:text/plain;base64,${Buffer.from(
            JSON.stringify(sourceMap)
          ).toString("base64")}`;
          contents += `\n//# sourceMappingURL=${map}`;
          return { contents, loader: "js" };
        } else {
          return {
            contents: peggy.generate(source, {
              ...options,
              output: "source",
            }),
          };
        }
      } catch (e) {
        return { errors: [convertMessage(e)] };
      }
    });
  },
};

runBuild([
  {
    entryPoints: [
      "src/optimizer.ts",
      "src/util.ts",
      "src/sdk-util.ts",
      "src/api.ts",
      "src/driver.ts",
      "src/worker-thread.ts",
      { in: "test/mocha/root.spec.ts", out: "mocha" },
      "src/cftinfo.ts",
    ],
    chunkNames: "chunk-[hash]",
    bundle: true,
    platform: "node",
    outdir: `${esmDir}`,
    target: "node16.4",
    external: [
      "@markw65/prettier-plugin-monkeyc",
      "prettier",
      "mocha",
      "chai",
      "7z-wasm",
    ],
    format: "esm",
    splitting: true,
    plugins: [
      peggyPlugin,
      startEndPlugin({
        onStart: () =>
          glob("build/*.cjs*").then((files) =>
            Promise.all(
              files
                .map((file) => fs.rm(file, { force: true }))
                .concat(fs.rm("build/esm", { recursive: true, force: true }))
            )
          ),
        onEnd: (result, options) => {
          false &&
            Object.entries(result.metafile.outputs).forEach(
              ([key, value]) =>
                key.endsWith(".js") &&
                console.log(`${key}: ${value.bytes >>> 10}kb`)
            ) &&
            console.log("");
          return Promise.all([
            cjsConfig(options.sourcemap)
              .then((config) =>
                runBuild([config], { watch: false, nots: true })
              )
              .then(([result]) => {
                console.log("");
                Object.entries(result.metafile.outputs).forEach(
                  ([key, value]) =>
                    key.endsWith(".cjs") &&
                    value.bytes > 10000 &&
                    console.log(`${key}: ${value.bytes >>> 10}kb`)
                );
                console.log("");
              }),
          ]);
        },
      }),
    ],
    define: {
      MONKEYC_OPTIMIZER_VERSION: JSON.stringify(MONKEYC_OPTIMIZER.version),
    },
    sourcesContent: false,
    metafile: true,
    logLevel: "silent",
    minify: false,
  },
]);
