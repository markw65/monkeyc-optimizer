import { buildOptimizedProject } from "../build/optimizer.cjs";
import * as path from "path";

async function test() {
  const jungles = [];
  let products;
  let developerKeyPath;
  let outputPath;
  let releaseBuild;
  process.argv.slice(2).forEach((arg) => {
    const match = /^--((?:\w|-)+)=(.*)$/.exec(arg);
    if (match) {
      switch (match[1]) {
        case "output-path":
          outputPath = match[2];
          break;
        case "dev-key":
          developerKeyPath = match[2];
          break;
        case "jungle":
          jungles.push(match[2]);
          break;
        case "release":
          releaseBuild = /^true|1$/i.test(match[2]);
          break;
        case "product":
          if (!products) products = [];
          products.push(...match[2].split(";"));
          break;
      }
    }
  });
  if (!jungles.length) throw new Error("No inputs!");
  let promise = Promise.resolve();
  jungles.forEach((jungleFiles) => {
    const workspace = path.dirname(jungleFiles.split(";")[0]);
    const options = {
      jungleFiles,
      workspace,
      developerKeyPath,
      outputPath,
      products,
      releaseBuild,
      compilerWarnings: true,
    };
    Object.entries(options).forEach(
      ([k, v]) => v === undefined && delete options[k]
    );
    promise = promise
      .then(() => buildOptimizedProject(products ? products[0] : null, options))
      .then(() => console.log(`Done: ${jungleFiles}`));
  });
  await promise;
}

test()
  .then(() => console.log("Success"))
  .catch((e) => {
    console.log("Failed: " + e.toString());
  });
