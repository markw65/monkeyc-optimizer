import { xmlUtil } from "../sdk-util";
import {
  Context,
  SECTION_PC_MASK,
  SectionKinds,
  TEXT_SECTION_PC,
} from "./bytecode";
import { UpdateInfo } from "./emit";

interface BaseLineNumber {
  pc: number;
  file?: number | undefined;
  fileStr?: string | undefined;
  symbol?: number | undefined;
  symbolStr?: string | undefined;
  line: number;
}

interface LineNumberSym extends BaseLineNumber {
  file: number;
  symbol: number;
  fileStr?: undefined;
  symbolStr?: undefined;
}
interface LineNumberStr extends BaseLineNumber {
  file?: undefined;
  symbol?: undefined;
  fileStr: string;
  symbolStr: string;
  parent?: string | undefined;
  id: number;
}

export type LineNumber = LineNumberStr | LineNumberSym;

export function parseLineNum(view: DataView, debugXml: xmlUtil.Document) {
  const size = view.getUint16(0);
  let current = 2;
  const results: Map<number, LineNumber> = new Map();
  for (let i = 0; i < size; i++) {
    const pc = view.getUint32((current += 4) - 4);
    const file = view.getUint32((current += 4) - 4);
    const symbol = view.getUint32((current += 4) - 4);
    const line = view.getUint32((current += 4) - 4);
    results.set(pc, { pc, file, symbol, line });
  }
  if (!(debugXml.body instanceof Error)) {
    debugXml.body
      .children("pcToLineNum")
      .children("entry")
      .elements.forEach((entry) => {
        const { filename, lineNum, symbol, pc, id, parent } = entry.attr;
        if (!filename || !lineNum || !symbol || !pc || !id || !parent) {
          return;
        }
        const pcNum = Number(pc.value.value);
        const e = results.get(pcNum) as LineNumberStr;
        if (e) {
          e.fileStr = filename.value.value;
          e.symbolStr = symbol.value.value;
          e.parent = parent.value.value;
          e.id = Number(id.value.value);
        } else {
          results.set(pcNum, {
            pc: pcNum,
            fileStr: filename.value.value,
            symbolStr: symbol.value.value,
            line: Number(lineNum.value.value),
            parent: parent.value.value,
            id: Number(id.value.value),
          });
        }
      });
  }
  return results;
}

export function fixupLineNum(context: Context, updateInfo: UpdateInfo) {
  const newLineTable = updateInfo.lineMap.concat(
    Array.from(context.lineTable.values()).filter(
      (lineNum) => (lineNum.pc & SECTION_PC_MASK) !== TEXT_SECTION_PC
    )
  );
  newLineTable.sort((a, b) => a.pc - b.pc);
  context.lineTable = new Map(newLineTable.map((l) => [l.pc, l]));
  const symLineTable = newLineTable.filter(
    (lineNum): lineNum is LineNumberSym => lineNum.file != null
  );
  const sectionLength = 2 + symLineTable.length * 16;
  const buffer = new ArrayBuffer(8 + sectionLength);
  const view = new DataView(buffer);
  view.setInt32(0, SectionKinds.LINENUM);
  view.setInt32(4, sectionLength);
  view.setInt16(8, symLineTable.length);
  let current = 10;
  symLineTable.forEach((lineNum) => {
    view.setUint32((current += 4) - 4, lineNum.pc);
    view.setUint32((current += 4) - 4, lineNum.file);
    view.setUint32((current += 4) - 4, lineNum.symbol);
    view.setUint32((current += 4) - 4, lineNum.line);
  });
  context.sections[SectionKinds.LINENUM].length = sectionLength;
  context.sections[SectionKinds.LINENUM].view = new DataView(
    buffer,
    8,
    sectionLength
  );
  const strLineTable = newLineTable.filter(
    (lineNum): lineNum is LineNumberStr => lineNum.fileStr != null
  );
  if (context.debugXml.body instanceof Error) return;
  context.debugXml.body.children("pcToLineNum").elements.forEach((e, i) => {
    if (i) {
      delete e.children;
      return;
    }
    e.children = strLineTable.flatMap((lineNum) => {
      const cd: xmlUtil.CharData = { type: "chardata", value: "\n" };
      const attr: Record<string, xmlUtil.Attribute> = {};
      attr.filename = xmlUtil.makeAttribute("filename", lineNum.fileStr);
      attr.id = xmlUtil.makeAttribute("id", lineNum.id.toString());
      attr.lineNum = xmlUtil.makeAttribute("lineNum", lineNum.line.toString());
      if (lineNum.parent) {
        attr.parent = xmlUtil.makeAttribute("parent", lineNum.parent);
      }
      attr.pc = xmlUtil.makeAttribute("pc", lineNum.pc.toString());
      attr.symbol = xmlUtil.makeAttribute("symbol", lineNum.symbolStr);
      const entry: xmlUtil.Element = {
        type: "element",
        name: "entry",
        attr,
      };
      return [cd, entry];
    });
  });
}
