#!/usr/bin/env node

const cft = require("../build/cftinfo.cjs");
const sdkUtil = require("../build/sdk-util.cjs");
const { globa } = require("../build/util.cjs");
const path = require("node:path");

const fonts = new Set();
const otherArgs = [];
let charsWanted;

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
)
  .then((results) =>
    Promise.all(
      Array.from(fonts).map((font) =>
        cft.getCFTFontInfo(font, charsWanted).catch(() => null)
      )
    )
      .then((fonts) =>
        Object.fromEntries(
          fonts
            .filter((font) => font != null)
            .map(({ name, ...rest }) => [name, rest])
        )
      )
      .then((fonts) => ({
        fonts,
        devices: Object.fromEntries(
          results
            .flat()
            .filter((result) => result != null)
            .map(({ device, ...rest }) => [device, rest])
        ),
      }))
  )
  .then((results) => console.log(JSON.stringify(results)));
