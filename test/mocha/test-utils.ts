import { assert } from "chai";
import { isStateNode } from "../../src/api";
import { hasProperty } from "../../src/ast";
import { analyze, getFileASTs } from "../../src/mc-rewrite";
import {
  BuildConfig,
  FilesToOptimizeMap,
  ProgramStateAnalysis,
  StateNodeDecl,
} from "../../src/optimizer-types";
import {
  ExactOrUnion,
  typeFromTypeStateNode,
  TypeTag,
} from "../../src/type-flow/types";
import { unionInto } from "../../src/type-flow/union-type";

export function create_program_analysis(
  source: string,
  filename: string,
  config: BuildConfig
) {
  const fnMap: FilesToOptimizeMap = {
    [filename]: { monkeyCSource: source, output: "", excludeAnnotations: {} },
  };
  return getFileASTs(fnMap).then(() =>
    analyze(fnMap, {}, undefined, config || {})
  );
}

export function find_by_name(state: ProgramStateAnalysis, name: string) {
  return name.split(".").reduce<StateNodeDecl[]>(
    (cur, next) => {
      return cur.flatMap((sn) =>
        isStateNode(sn)
          ? ((hasProperty(sn.decls, next) && sn.decls[next]) || []).concat(
              (hasProperty(sn.type_decls, next) && sn.type_decls[next]) || []
            )
          : []
      );
    },
    [state.stack[0]]
  );
}

export function find_type_by_name(state: ProgramStateAnalysis, name: string) {
  const sns = find_by_name(state, name);
  if (!sns.length) throw new Error(`Didn't find any state nodes for ${name}`);

  return sns.reduce<ExactOrUnion>(
    (result, sn) => {
      unionInto(result, typeFromTypeStateNode(state, sn, false));
      return result;
    },
    { type: TypeTag.Never }
  );
}

export function assertNonNull<T>(
  obj: T,
  message?: string
): asserts obj is NonNullable<T> {
  assert.isNotNull(obj, message);
}
