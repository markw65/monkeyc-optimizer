import { buildOptimizedProject } from "../src/optimizer.js";
import * as path from "path";

async function test() {
  const jungles = [];
  let build_all = false;
  let developer_key = null;
  let output_path = null;
  process.argv.slice(2).forEach((arg) => {
    const match = /^--((?:\w|-)+)=(.*)$/.exec(arg);
    if (match) {
      switch (match[1]) {
        case "output-path":
          output_path = match[2];
          break;
        case "dev-key":
          developer_key = match[2];
          break;
        case "jungle":
          jungles.push(match[2]);
          break;
        case "build-all":
          // should we build each product for every supported device,
          // or just pick one device for each product.
          build_all = /^(true|1|yes)$/i.test(match[2]);
          break;
      }
    }
  });
  if (!jungles.length) throw "No inputs!";
  let promise = Promise.resolve();
  jungles.forEach((jungleFiles) => {
    const workspace = path.dirname(jungleFiles.split(";")[0]);
    const options = { jungleFiles, workspace };
    if (developer_key) {
      options.developerKeyPath = developer_key;
    }
    if (output_path) {
      options.outputPath = output_path;
    }
    promise = promise
      .then(() => buildOptimizedProject(options))
      .then(() => console.log(`Done: ${jungleFiles}`));
  });
  await promise;
}

test()
  .then(() => console.log("Success"))
  .catch(() => console.log("Failed"));
