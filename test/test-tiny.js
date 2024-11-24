const { spawnByLine } = require("../build/util.cjs");
const fs = require("node:fs/promises");
const path = require("node:path");
const glob = require("fast-glob");

const args = [
  "test/test.js",
  "--postOptimize",
  "--showInfo",
  "--typeCheckLevel",
  "Strict",
  "--run-tests",
  "--product=pick-one",
];

async function testOne(jungle) {
  console.log(`\n>>> Building ${jungle}\n`);
  const dir = path.dirname(jungle);
  await fs.rm(path.resolve(dir, "bin"), {
    recursive: true,
    force: true,
  });
  const extraArgs = await fs
    .readFile(path.resolve(dir, "extra-args"), "utf-8")
    .then((content) =>
      content.split(/[\r\n]+/).map((arg) => arg.replace(/^\s*(.*?)\s*$/, "$1"))
    )
    .catch(() => []);
  const cmd = args.concat("--jungle", jungle, extraArgs);
  await [cmd.concat("--analyze-only"), cmd].reduce((p, c) => {
    return p.then(() => {
      console.log(`Running: ${c.map((s) => JSON.stringify(s)).join(" ")}`);
      return spawnByLine("node", c, (line) => console.log(line));
    });
  }, Promise.resolve());
}

const jungles = process.argv.slice(2).filter((arg) => arg.endsWith(".jungle"));

glob(jungles.length ? jungles : "test/tiny/*/monkey.jungle")
  .then((jungles) =>
    jungles.reduce(
      (promise, jungle) => promise.then(() => testOne(jungle)),
      Promise.resolve()
    )
  )
  .catch((e) => {
    if (e instanceof Error) {
      console.error(`Failed with error: ${e}`);
    }
    process.exit(1);
  });
