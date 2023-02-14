import { xmlUtil } from "../sdk-util";

export class SymbolTable {
  // given a symbol id, symbolToLabelMap.get(id) gives the
  // label offset, then symbols.get(label) gives us the symbol
  // name
  symbolToLabelMap = new Map<number, number>();
  labelToSymbolMap = new Map<number, number>();
  symbols = new Map<number, { str: string; label: string }>();
  methods = new Map<number, string>();
  decoder = new TextDecoder();

  parseSymbolTable(view: DataView) {
    let current = 0;
    const size = view.getUint16((current += 2) - 2);
    for (let i = 0; i < size; i++) {
      const symbol = view.getInt32((current += 4) - 4);
      const label = view.getInt32((current += 4) - 4);
      this.symbolToLabelMap.set(symbol, label);
      this.labelToSymbolMap.set(label, symbol);
    }
    return current;
  }

  parse(view: DataView) {
    let current = this.parseSymbolTable(view);
    while (current < view.byteLength) {
      current = this.parseSymbol(view, current, current + 1);
    }
  }

  parseXml(debugXml: xmlUtil.Document) {
    if (debugXml.body instanceof Error) return;
    debugXml.body
      .children("functions")
      .children("functionEntry")
      .elements.forEach((functionEntry) => {
        const { startPc, name, parent } = functionEntry.attr;
        if (!startPc || !name) return;
        const fullName =
          (parent ? debugXml.processRefs(parent.value.value) + "." : "") +
          debugXml.processRefs(name.value.value);
        const pc = Number(startPc.value.value) & 0xffffff;
        this.methods.set(pc, fullName);
      });
  }

  parseSymbol(view: DataView, offset: number, current: number) {
    const length = view.getUint16(current);
    current += 2;
    const str = this.decoder.decode(
      new DataView(view.buffer, current + view.byteOffset, length)
    );
    current += length + 1;
    const label = str.replace(/\W/g, "_") + "_" + hash(str);
    const sym = { str, label };
    this.symbols.set(offset, sym);
    //console.log(`${str} => ${offset.toString(16)}`);
    return current;
  }
}

function hash(s: string) {
  let h = 9;
  for (let i = 0; i < s.length; ) {
    h = Math.imul(h ^ s.charCodeAt(i++), 9 ** 9);
  }
  return (h ^ (h >>> 9)) >>> 0;
}
