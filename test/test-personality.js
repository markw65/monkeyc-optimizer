const { spawnByLine, globa } = require("../build/util.cjs");
const { getSdkPath } = require("../build/sdk-util.cjs");
const { parseSdkVersion } = require("../build/api.cjs");
const fs = require("node:fs/promises");

const args = ["test/test.js", "--jungle=test/TestPersonality/monkey.jungle"];

async function testOne(product, resources, locX) {
  await fs.rm("test/TestPersonality/bin", { recursive: true, force: true });
  await spawnByLine(
    "node",
    args.concat(product ? ["--product", product] : []),
    (line) => console.log(line)
  );

  if (product) {
    const jungle = await fs.readFile(
      "test/TestPersonality/bin/optimized/debug.jungle",
      { encoding: "utf-8" }
    );

    const re1 = new RegExp(`${product}\\.personality.*${resources}`);
    if (!re1.test(jungle)) {
      throw new Error(`Incorrect personality map for ${product}`);
    }

    const mcgens = await globa(
      "test/TestPersonality/bin/gen/*/source/Rez.mcgen"
    );
    if (!mcgens || mcgens.length !== 1) {
      throw new Error(`Didn't find Rez.mcgen for ${product} build`);
    }
    const mcgen = await fs.readFile(mcgens[0], { encoding: "utf-8" });
    const match = mcgen.match(/rez_cmp_local_text_WeightLabel.*/);
    if (!match) {
      throw new Error(`Didn't find WeightLabel definition for ${product}`);
    }
    const re2 = new RegExp(`rez_cmp_local_text_WeightLabel.*:locX=>${locX},`);

    if (!re2.test(match[0])) {
      throw new Error(
        `Personality not applied correctly for ${product}: ${match[0]}`
      );
    }
  }
}

Promise.resolve()
  .then(() => getSdkPath())
  .then((sdk) => {
    const match = sdk.match(/-(\d+\.\d+\.\d+)/);
    if (match) {
      const sdkVersion = parseSdkVersion(match[1]);
      if (sdkVersion < 4002001) {
        console.log(
          `Skipping personality test because sdk-${match[1]} does not support them.`
        );
        process.exit(0);
      }
    }
  })
  .then(() =>
    testOne(
      "venu2",
      "personality-round",
      "\\(\\d+\\s*\\*\\s*\\(25 / 100.0\\)\\)"
    )
  )
  .then(() => testOne("edge_1000", "personality-rectangle-240x400", "10"))
  .then(() => testOne(null, null, null))
  .catch((e) => {
    if (e instanceof Error) {
      console.error(`Failed with error: ${e}`);
    }
    process.exit(1);
  });
