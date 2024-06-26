const { spawnByLine, globa } = require("../build/util.cjs");
const fs = require("node:fs/promises");
const path = require("node:path");

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
  await spawnByLine("node", args.concat("--jungle", jungle), (line) =>
    console.log(line)
  );
}

globa("test/tiny/*/monkey.jungle")
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
