#!/usr/bin/env node

const cft = require("../build/cftinfo.cjs");
const sdkUtil = require("../build/sdk-util.cjs");
const { globa, promiseAll } = require("../build/util.cjs");
const path = require("node:path");

const fonts = new Set();
const otherArgs = [];
let charsWanted;
let charInfoAsArray;
let flatFonts;

function error(e) {
  throw new Error(e);
}

const prev = process.argv.slice(2).reduce((key, value) => {
  const plain = !key && !value.startsWith("--");
  if (plain) {
    otherArgs.push(value);
    return null;
  }
  const match = /^--((?:\w|-)+)(?:=(.*))?$/.exec(value);
  if (!key) {
    if (!match) {
      error(`Expected an argument but got: ${value}`);
    }
    key = match[1];
    value = match[2];
  } else if (match) {
    error(`Missing arg for '${key}'`);
  }
  switch (key) {
    case "chars":
      if (value == null) return key;
      charsWanted = (charsWanted ?? "") + value;
      break;
    case "char-info-as-array":
      charInfoAsArray = !value || /^(true|1)$/i.test(value);
      break;
    case "flat-fonts":
      flatFonts = !value || /^(true|1)$/i.test(value);
      break;
    default:
      error(`Unknown argument: --${key}`);
  }
  return null;
}, null);
if (prev) error(`Missing arg for '${prev}'`);

Promise.all(
  otherArgs.map((filename) => {
    if (/\.cft$/i.test(filename)) {
      return globa(path.resolve(sdkUtil.connectiq, "Fonts", filename)).then(
        (filenames) => {
          filenames.forEach((fn) => fonts.add(fn));
          return null;
        }
      );
    }
    return globa(path.resolve(sdkUtil.connectiq, "Devices", filename), {
      mark: true,
    }).then((devices) =>
      Promise.all(
        devices.map((device) => {
          if (!device.endsWith("/")) return null;
          return cft.getDeviceFontInfo(device).then((devInfo) => {
            Object.values(devInfo.fontSets).forEach((fontSet) =>
              Object.values(fontSet).forEach((file) =>
                fonts.add(
                  path.resolve(sdkUtil.connectiq, "Fonts", `${file}.cft`)
                )
              )
            );
            return devInfo;
          });
        })
      )
    );
  })
).then((results) => {
  console.log(`{${flatFonts ? "" : `\n"fonts":{`}`);
  let started = false;
  let last = -1;
  let active = [];
  const fontArray = Array.from(fonts).sort();
  return promiseAll(
    (i) =>
      fontArray[i] &&
      cft
        .getCFTFontInfo(fontArray[i], { chars: charsWanted, charInfoAsArray })
        .then(({ name, ...rest }) => `"${name}":${JSON.stringify(rest)}`)
        .catch(() => null)
        .then((line) => {
          active[i] = line;
          while (active[last + 1] !== undefined) {
            const a = active[++last];
            if (a != null) {
              console.log(started ? "," : "", a);
              started = true;
            }
            delete active[last];
          }
        })
  )
    .then(() => active.forEach((line) => line && console.log(line)))
    .then(() =>
      console.log(
        flatFonts ? "," : "},\n",
        `"devices":${JSON.stringify(
          Object.fromEntries(
            results
              .flat()
              .filter((result) => result != null)
              .map(({ device, ...rest }) => [device, rest])
          )
        )}`
      )
    )
    .then(() => console.log("}"));
});
