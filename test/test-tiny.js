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
  await fs.rm(path.resolve(path.dirname(jungle), "bin"), {
    recursive: true,
    force: true,
  });
  const cmd = args.concat("--jungle", jungle);
  console.log(`Running: ${cmd.map((s) => JSON.stringify(s)).join(" ")}`);
  await spawnByLine("node", cmd, (line) => console.log(line));
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
