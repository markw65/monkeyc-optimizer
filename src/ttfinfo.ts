import * as opentype from "opentype.js";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { FontInfoOptions } from "./cftinfo";
export function getTTFFontInfo(
  filename: string,
  size: number,
  options?: FontInfoOptions | string
) {
  const { chars, charInfoAsArray } = (
    typeof options === "string" ? { chars: options } : (options ?? {})
  ) satisfies FontInfoOptions;
  const name = path.basename(filename) + ":" + size;
  return fs.readFile(filename).then((buffer) => {
    const font = opentype.parse(buffer);

    const glyphMap = font.tables.cmap.glyphIndexMap;

    // Extract and sort the Unicode keys numerically
    const unicodeKeys = Object.keys(glyphMap)
      .map(Number)
      .filter((c) => chars == null || chars.includes(String.fromCharCode(c)))
      .sort((a, b) => a - b);

    const charInfo: {
      code: number;
      char: string;
      width: number;
      glyphAscent: number;
      glyphDescent: number;
    }[] = [];

    const scale = (size * 72) / 25.4 / font.unitsPerEm;
    unicodeKeys.forEach((code) => {
      const char = String.fromCharCode(code);

      const glyph = font.charToGlyph(char);
      const width = (glyph.advanceWidth ?? 0) * scale;
      const glyphAscent = Math.max(0, glyph.yMax ?? 0) * scale;
      const glyphDescent = Math.max(0, -(glyph.yMin ?? 0)) * scale;
      charInfo.push({
        code,
        char,
        width,
        glyphAscent,
        glyphDescent,
      });
    });

    const winAscent = font.tables.os2.usWinAscent;
    const winDescent = font.tables.os2.usWinDescent;
    const emSquare = font.unitsPerEm;
    const fullHeight = winAscent + winDescent;
    const internalLeadingUnits = fullHeight - emSquare;

    const height = fullHeight * scale;
    const ascent = winAscent * scale;
    const internalLeading = internalLeadingUnits * scale;

    if (charInfoAsArray && charInfo.length) {
      return {
        name,
        height,
        ascent,
        internalLeading,
        charInfo: charInfo.map((info) => Object.values(info)),
        charInfoNames: Object.keys(charInfo[0]),
      };
    }
    return {
      name,
      height,
      ascent,
      internalLeading,
      charInfo,
    };
  });
}
