import assert from "node:assert";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { hasProperty } from "./ast";

/*
HEADER section
Offset  Field               Size
0       HeaderSize              2       36 or 40
2       Flag                    1
3       Flag                    1       Bit 1 indicates run length encoding, bit 2 = 2-bit vs 1-bit font
4       FileSize                4       Total size of cft file
8       CMapOffset              4       Probably same as HeaderSize - the CMAPs start right after the header
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

enum GlyphFlags {
  RLE = 2,
  TwoBit = 4,
}

export async function getCFTFontInfoFromBuffer(
  name: string,
  data: Buffer,
  chars?: string
) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const glyphFlags: GlyphFlags = view.getUint8(3);
  const cmapOffset = view.getUint32(8);
  const glyphInfoOffset = view.getUint32(12);
  const glyphDataOffset = view.getUint32(16);
  const height = view.getUint16(22);
  const ascent = view.getUint16(24);
  const internalLeading = view.getUint16(26);
  const charFilter = chars
    ? new Set(chars.split("").map((ch) => ch.charCodeAt(0)))
    : null;

  const cmapNGroups = view.getUint32(cmapOffset + 12);
  const charInfo: {
    code: number;
    char: string;
    width: number;
    glyphAscent: number;
    glyphDescent: number;
  }[] = [];
  const maybeCompressed = view.getUint16(0) === 40;
  const align = maybeCompressed ? view.getUint8(36) : 1;

  const glyphData = await getGlyphData(view, glyphDataOffset, maybeCompressed);

  for (let i = 0, offset = cmapOffset + 16; i < cmapNGroups; i++) {
    const startChar = view.getUint32(offset + 0);
    const endChar = view.getUint32(offset + 4);
    const startGlyph = view.getUint32(offset + 8);
    offset += 12;
    for (let code = startChar, g = startGlyph; code <= endChar; code++, g++) {
      if (charFilter && !charFilter.has(code)) {
        continue;
      }
      const word = view.getUint32(glyphInfoOffset + g * 4);
      const glyphOffset = ((word >> 16) & 0xffff) + ((word & 0xff00) << 8);
      const width = word & 0xff;
      const [glyphAscent, glyphDescent] = getGlyphAscentDescent(
        glyphData,
        glyphOffset,
        width,
        height,
        ascent,
        align,
        glyphFlags
      );
      charInfo.push({
        code,
        char: String.fromCharCode(code),
        width,
        glyphAscent,
        glyphDescent,
      });
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

export function getCFTFontInfo(filename: string, chars?: string) {
  return fs.readFile(filename).then((data) => {
    const name = path.basename(filename, ".cft");
    return getCFTFontInfoFromBuffer(name, data, chars);
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

async function getGlyphData(
  view: DataView,
  offset: number,
  maybeCompressed: boolean
) {
  if (maybeCompressed) {
    const firstWord = view.getUint32(offset);
    if (firstWord === 3439329293) {
      offset += 4;
    } else if (firstWord === 3489660941) {
      offset += 4;
      maybeCompressed = false;
    }
  }
  if (maybeCompressed) {
    const result: Buffer[] = [];
    const _length = view.getUint32(offset);
    offset += 4;
    const inflate = zlib.createInflate();
    inflate.on("data", (chunk: Buffer) => result.push(chunk));
    const promise = new Promise<Buffer>((resolve, reject) => {
      inflate.on("end", () => resolve(Buffer.concat(result)));
      inflate.on("error", (e) => reject(e));
    });
    inflate.write(
      Buffer.from(
        view.buffer,
        view.byteOffset + offset,
        view.byteLength - offset
      )
    );
    inflate.end();
    const buffer = await promise;
    return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }
  return new DataView(
    view.buffer,
    view.byteOffset + offset,
    view.byteLength - offset
  );
}

function getGlyphAscentDescent(
  glyphData: DataView,
  glyphOffset: number,
  width: number,
  height: number,
  ascent: number,
  align: number,
  flags: GlyphFlags
) {
  const rle = (glyphOffset & 0x800000) !== 0;
  glyphOffset &= 0x7fffff;
  const pixelsPerByte = flags & GlyphFlags.TwoBit ? 4 : 8;
  const bytesToCount = Math.ceil(width / pixelsPerByte);
  const byteWidth = Math.ceil(bytesToCount / align) * align;
  const size = byteWidth * height;
  const glyph = rle
    ? rleDecode(glyphData, glyphOffset, size)
    : new DataView(glyphData.buffer, glyphData.byteOffset + glyphOffset, size);
  const glyphAscent = (() => {
    let row = 0;
    do {
      const offset = row * byteWidth;
      for (let i = 0; i < bytesToCount; i++) {
        if (glyph.getUint8(offset + i)) return ascent - row;
      }
    } while (++row < ascent);
    return 0;
  })();
  const glyphDescent = (() => {
    let row = height;
    while (row-- > ascent) {
      const offset = row * byteWidth;
      for (let i = 0; i < bytesToCount; i++) {
        if (glyph.getUint8(offset + i)) return row - ascent;
      }
    }
    return 0;
  })();
  return [glyphAscent, glyphDescent];
}

function rleDecode(encoded: DataView, offset: number, size: number) {
  let bitsLeft = 0;
  let val = 0;
  const getBits = (n: number): number => {
    if (bitsLeft >= n) {
      const result = val & ((1 << n) - 1);
      bitsLeft -= n;
      val >>>= n;
      return result;
    }
    if (bitsLeft === 0) {
      val = encoded.getUint8(offset);
      offset += 1;
      bitsLeft = 8;
      return getBits(n);
    }
    const bl = bitsLeft;
    return getBits(bl) + (getBits(n - bl) << bl);
  };
  let runBits = 1;
  while (getBits(1) === 0) {
    runBits++;
  }
  const chunkSize = getBits(5) + 1;
  const escape = getBits(chunkSize);
  const output = new DataView(new ArrayBuffer((size + 3) & ~3));
  let outOffset = 0;
  let outBitOff = 0;
  let outVal = 0;
  const putBits = (value: number) => {
    outVal |= value << outBitOff;
    outBitOff += chunkSize;
    if (outBitOff >= 32) {
      output.setUint32(outOffset, outVal, true);
      outOffset += 4;
      outBitOff -= 32;
      outVal = 0;
      if (outBitOff !== 0) {
        outVal = value >>> (chunkSize - outBitOff);
      }
    }
  };

  let prev = -1;
  const getChunk = () => {
    const val = getBits(chunkSize);
    if (val !== escape) {
      prev = val;
      return [val, 1];
    }
    const run = getBits(runBits);
    if (run === 0) {
      prev = val;
      return [val, 1];
    }
    return [prev, run + 1];
  };
  while (outOffset + (outBitOff >>> 3) < size) {
    let [val, run] = getChunk();
    while (run--) {
      putBits(val);
    }
  }
  if (outOffset < size) {
    output.setUint32(outOffset, outVal, true);
  }
  return output;
}
