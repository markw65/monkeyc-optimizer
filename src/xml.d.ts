import { xmlUtil } from "./sdk-util";

export declare function parse(
  input: string,
  options: Record<string, unknown>
): [xmlUtil.Prolog, xmlUtil.Element, xmlUtil.Misc[]];
