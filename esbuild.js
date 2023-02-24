import * as esbuild from "esbuild";
import glob from "fast-glob";
import * as child_process from "node:child_process";
import * as fs from "node:fs/promises";
import peggy from "peggy";
import * as readline from "node:readline";
import * as path from "node:path";

const MONKEYC_OPTIMIZER = JSON.parse(await fs.readFile("./package.json"));

const esmDir = "build/esm";
const cjsDir = "build";
const sourcemap = !process.argv.includes("--release");

const cjsConfig = async () => {
  const files = await glob(`${esmDir}/**/*.js`);
  return {
    entryPoints: files,
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
  };
};

const fixImportsPlugin = {
  name: "fix-imports",
  setup(build) {
    build.onLoad({ filter: /\.js$/ }, async (args) => {
      // Load the file from the file system
      const source = await fs.readFile(args.path, "utf8");
      const contents = source
        .replace(/(\s(?:from|import)\s+".\/chunk-.*\.)(js")/g, "$1c$2")
        .replace("lastModifiedSource", Date.now().toString());
      return { contents };
    });
  },
};

const startEndPlugin = {
  name: "startEnd",
  setup(build) {
    build.onStart(() => {
      console.log(`${new Date().toLocaleString()} - ESBuild start`);
      return glob("build/*.cjs*")
        .then((files) =>
          Promise.all(
            files
              .map((file) => fs.rm(file, { force: true }))
              .concat(fs.rm("build/esm", { recursive: true, force: true }))
          )
        )
        .then(() => {});
    });
    build.onEnd((result) => {
      false &&
        Object.entries(result.metafile.outputs).forEach(
          ([key, value]) =>
            key.endsWith(".js") &&
            console.log(`${key}: ${value.bytes >>> 10}kb`)
        ) &&
        console.log("");
      return Promise.all([
        cjsConfig()
          .then((config) => esbuild.build(config))
          .then((result) => {
            console.log("");
            Object.entries(result.metafile.outputs).forEach(
              ([key, value]) =>
                key.endsWith(".cjs") &&
                value.bytes > 10000 &&
                console.log(`${key}: ${value.bytes >>> 10}kb`)
            );
            console.log("");
          }),
        //esbuild.analyzeMetafile(result.metafile).then((info) => console.log(info)),
      ]).then(() => {
        console.log(`${new Date().toLocaleString()} - ESBuild end`);
      });
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

      // Convert Svelte syntax to JavaScript
      try {
        const mapDir = path.resolve(build.initialOptions.outdir, "..");
        const sourceAndMap = peggy
          .generate(source, {
            cache: false,
            format: "es",
            output: "source-and-map",
            grammarSource: args.path,
          })
          .toStringWithSourceMap({
            /*file: path.resolve(
              mapDir,
              path.basename(args.path, ".peggy") + ".js"
            ),*/
            //sourceRoot: process.cwd(),
          });
        let contents = sourceAndMap.code;
        if (build.initialOptions.sourcemap) {
          const sourceMap = sourceAndMap.map.toJSON();
          sourceMap.sources = sourceMap.sources.map((src) => {
            return src === null ? null : path.relative(mapDir, src);
          });
          const map = `data:text/plain;base64,${Buffer.from(
            JSON.stringify(sourceMap)
          ).toString("base64")}`;
          contents += `\n//# sourceMappingURL=${map}`;
        }
        return { contents, loader: "js" };
      } catch (e) {
        return { errors: [convertMessage(e)] };
      }
    });
  },
};

const esmConfig = {
  entryPoints: [
    "src/optimizer.ts",
    "src/util.ts",
    "src/sdk-util.ts",
    "src/api.ts",
    "src/driver.ts",
    "src/worker-thread.ts",
    "src/worker-pool.ts",
    { in: "test/mocha/root.spec.ts", out: "mocha" },
  ],
  chunkNames: "chunk-[hash]",
  bundle: true,
  platform: "node",
  outdir: `${esmDir}`,
  target: "node16.4",
  external: ["@markw65/prettier-plugin-monkeyc", "prettier", "mocha", "chai"],
  format: "esm",
  splitting: true,
  plugins: [peggyPlugin, startEndPlugin],
  define: {
    MONKEYC_OPTIMIZER_VERSION: JSON.stringify(MONKEYC_OPTIMIZER.version),
  },
  sourcemap,
  sourcesContent: false,
  metafile: true,
};

function spawnByLine(command, args, lineHandler, options) {
  return new Promise((resolve, reject) => {
    const proc = child_process.spawn(command, args, {
      ...(options || {}),
      shell: false,
    });
    const rl = readline.createInterface({
      input: proc.stdout,
    });
    const rle = readline.createInterface({
      input: proc.stderr,
    });
    proc.on("error", reject);
    proc.stderr.on("data", (data) => console.error(data.toString()));
    rl.on("line", lineHandler);
    rle.on("line", lineHandler);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      reject(code);
    });
  });
}

const tscCommand = ["tsc", "--emitDeclarationOnly", "--outDir", "build/src"];

if (process.argv.includes("--watch")) {
  const ctx = await esbuild.context(esmConfig);
  await Promise.all([
    ctx.watch(),
    spawnByLine("npx", tscCommand.concat("--watch"), (line) =>
      // tsc in watch mode does ESC-c to clear the screen
      // eslint-disable-next-line no-control-regex
      console.log(line.replace(/[\x1b]c/g, ""))
    ),
  ]);
} else {
  await Promise.all([
    esbuild.build(esmConfig),
    spawnByLine("npx", tscCommand, (line) => console.log(line)).then(() => {
      console.log(`${new Date().toLocaleString()} - tsc end`);
    }),
  ]);
}
