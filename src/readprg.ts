import * as fs from "fs/promises";

export enum SectionKinds {
  TEXT = 0xc0debabe | 0,
  DATA = 0xda7ababe | 0,
}

export async function readPrg(path: string) {
  const data = await fs.readFile(path);
  const view = new DataView(data.buffer);

  const sections: Record<number, number> = {};
  let offset = 0;
  while (view.byteLength - offset > 8) {
    const type = view.getInt32(offset);
    offset += 4;
    const length = view.getInt32(offset);
    offset += 4;
    if (length > view.byteLength - offset) {
      throw new Error(`Invalid length for section ${type}`);
    }
    sections[type] = length;
    offset += length;
  }
  return sections;
}
