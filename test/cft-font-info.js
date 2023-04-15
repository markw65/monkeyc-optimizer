#!/usr/bin/env node

const cft = require("../build/cftinfo.cjs");
const sdkUtil = require("../build/sdk-util.cjs");
const { globa } = require("../build/util.cjs");
const path = require("node:path");

const fonts = new Set();
Promise.all(
  process.argv.slice(2).map((filename) => {
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
        cft.getCFTFontInfo(font).catch(() => null)
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
