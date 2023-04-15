import assert from "node:assert";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { hasProperty } from "./ast";

/*
HEADER section
Offset  Field               Size
0       HeaderSize              2       36 or 40
2       Flag                    1
3       Flag                    1       Bit 1 indicates run length encoding?
4       FileSize                4       Total size of cft file
8       CMapOffset              4       Probably same as Headersize - the cmaps start right after the header
12      GlyphInfoOffset         4       Start offset of GlyphInfoTable
16      GlyphDataOffset         4       Start offset of GlyphDataTable
20      ShortMax                2       Always 0x7fff?
22      Height                  2       Height in pixels
24      Ascent                  2       Height above baseline
26      InternalLeading         2       Distance from baseline to top of next line (ie the next row's baseline should be InternalLeading + Ascent below this one)
28      Flag                    2       Always zero?
30      ExternalLeading         2       Always one? Additional vertical space between lines?
32      rleFlag                 4       0 without rle, 0x12345678 with rle

CMAP section - see https://learn.microsoft.com/en-us/typography/opentype/spec/cmap
CMapOffset +
0       Format                  2
2       reserved                0       Zero
4       CMAPLength              4       Length of CMAP section. Typically CMapOffset + CMAPLength === GlyphInfoOffset
8       CMAPLanguage            4
12      CMAPNGroups             4       Number of groups

CMAP groups: Starts at CMapOffset + 16, repeats CMAPNGroups times
0       StartCharacter          4
4       EndCharacter            4       (inclusive)
8       StartGlyph              4       Index into the GlyphInfoTable

GlyphInfoTable: Starts at GlyphInfoOffset
0       Offset-lo               2       Low two bytes of offset into GlyphDataTable
2       Offset-hi               1       High byte of offset into GlyphDataTable (usually with top bit set?)
3       Width                   1       The glyph Width
*/

export function getCFTFontInfoFromBuffer(name: string, data: Buffer) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const cmapOffset = view.getUint32(8);
  const glyphInfoOffset = view.getUint32(12);
  const height = view.getUint16(22);
  const ascent = view.getUint16(24);
  const internalLeading = view.getUint16(26);

  const cmapNGroups = view.getUint32(cmapOffset + 12);
  const charInfo: { code: number; char: string; width: number }[] = [];

  for (let i = 0, offset = cmapOffset + 16; i < cmapNGroups; i++) {
    const startChar = view.getUint32(offset + 0);
    const endChar = view.getUint32(offset + 4);
    const startGlyph = view.getUint32(offset + 8);
    offset += 12;
    for (let code = startChar, g = startGlyph; code <= endChar; code++, g++) {
      const width = view.getUint8(glyphInfoOffset + g * 4 + 3);
      charInfo.push({ code, char: String.fromCharCode(code), width });
    }
  }

  return {
    name,
    height,
    ascent,
    internalLeading,
    charInfo,
  };
}

export function getCFTFontInfo(filename: string) {
  return fs.readFile(filename).then((data) => {
    const name = path.basename(filename, ".cft");
    return getCFTFontInfoFromBuffer(name, data);
  });
}

export function getDeviceFontInfo(dirname: string) {
  return Promise.all([
    fs.readFile(path.resolve(dirname, "compiler.json"), "utf-8"),
    fs.readFile(path.resolve(dirname, "simulator.json"), "utf-8"),
  ]).then(([compiler, simulator]) => {
    const fonts = JSON.parse(simulator).fonts as Array<{
      fontSet: string;
      fonts: Array<{ filename: string; name: string }>;
    }>;
    const fontSets = Object.fromEntries(
      fonts.map(({ fontSet, fonts }) => [
        fontSet,
        Object.fromEntries(
          fonts.map(({ filename, name }) => [
            "FONT_" + name.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase(),
            filename,
          ])
        ),
      ])
    );
    const partNumbers = JSON.parse(compiler).partNumbers as Array<{
      languages: Array<{ code: string; fontSet: string }>;
    }>;
    const langMap: Record<string, string> = {};
    partNumbers.map((part) =>
      part.languages.map((lang) => {
        assert(hasProperty(fontSets, lang.fontSet));
        if (hasProperty(langMap, lang.code)) {
          assert(langMap[lang.code] === lang.fontSet);
        } else {
          langMap[lang.code] = lang.fontSet;
        }
      })
    );
    return { device: path.basename(dirname), fontSets, langMap };
  });
}
