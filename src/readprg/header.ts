import { Context, SectionKinds } from "./bytecode";
import { UpdateInfo } from "./emit";

export type SectionOffset = {
  data: number;
  code: number;
};

export type Header = {
  headerVersion: number;
  ciqVersion: number;
  backgroundOffsets: SectionOffset;
  appLock: boolean;
  glanceOffsets: SectionOffset;
  flags: number;
};

export function parseHeader(view: DataView) {
  let offset = 0;
  const word = view.getUint32((offset += 4) - 4);
  const ciqVersion = word & 0xffffff;
  const headerVersion = word >>> 24;
  const header: Header = {
    headerVersion,
    ciqVersion,
    backgroundOffsets: { data: 0, code: 0 },
    appLock: false,
    glanceOffsets: { data: 0, code: 0 },
    flags: 0,
  };
  if (view.byteLength > offset) {
    header.backgroundOffsets.data = view.getUint32((offset += 4) - 4);
    header.backgroundOffsets.code = view.getUint32((offset += 4) - 4);
  }
  if (view.byteLength > offset) {
    header.appLock = view.getInt8(offset++) !== 0;
  }
  if (view.byteLength > offset) {
    offset += 8;
    header.glanceOffsets.data = view.getUint32((offset += 4) - 4);
    header.glanceOffsets.code = view.getUint32((offset += 4) - 4);
  }
  if (view.byteLength > offset) {
    header.flags = view.getUint32((offset += 4) - 4);
  }
  return header;
}

export function fixupHeader(context: Context, updateInfo: UpdateInfo) {
  const view = (
    context.sections[SectionKinds.HEADER] ??
    context.sections[SectionKinds.HEADER_VERSIONED]
  ).view;
  if (context.header.backgroundOffsets.code !== 0) {
    const offset = updateInfo.offsetMap.get(
      context.header.backgroundOffsets.code
    );
    if (offset == null) {
      throw new Error("Failed to update background offset");
    }
    context.header.backgroundOffsets.code = offset;
    view.setUint32(8, offset);
  }
  if (context.header.glanceOffsets.code !== 0) {
    const offset = updateInfo.offsetMap.get(context.header.glanceOffsets.code);
    if (offset == null) {
      throw new Error("Failed to update glance offset");
    }
    context.header.glanceOffsets.code = offset;
    view.setUint32(25, offset);
  }
}
