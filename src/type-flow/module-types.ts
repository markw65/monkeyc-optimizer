import { RootStateNode } from "src/control-flow";
import { ProgramStateAnalysis, ProgramStateNode } from "../optimizer-types";
import { couldBeWeak } from "./could-be";
import { InterpState, TypeMap, evaluate } from "./interp";
import { subtypeOf } from "./sub-type";
import { buildTypeInfo } from "src/type-flow";

export function analyze_module_types(state: ProgramStateAnalysis) {
  if (
    !state.config?.propagateTypes ||
    !state.config.trustDeclaredTypes ||
    state.config.checkTypes === "OFF"
  ) {
    return null;
  }
  const typeChecker =
    state.config.strictTypeCheck?.toLowerCase() === "on"
      ? subtypeOf
      : couldBeWeak;
  const checkTypes = state.config?.checkTypes || "WARNING";

  const rootList: RootStateNode[] = [
    state.stack[0].sn as ProgramStateNode,
    ...state.allModules,
    ...state.allClasses,
  ];
  const modulesSet = new Set<RootStateNode>(rootList);

  const moduleMap = new Map<RootStateNode, InterpState>();
  for (const module of modulesSet) {
    modulesSet.delete(module);
    const istate = buildTypeInfo(state, module, false);
    if (istate?.typeMap) {
      moduleMap.set(module, istate);
    }
  }

  const typeMap: TypeMap = new Map();
  rootList.push(...Object.values(state.allFunctions).flat());
  for (const root of rootList) {
    const istate = moduleMap.get(root) ?? buildTypeInfo(state, root, false);
    if (istate) {
      istate.typeChecker = typeChecker;
      istate.checkTypes = checkTypes;
      if (root.nodes) {
        root.nodes.forEach((stack, node) => {
          evaluate(istate, node);
        });
      } else {
        evaluate(istate, root.node!);
      }
      istate.typeMap?.forEach((value, key) => typeMap.set(key, value));
    }
  }
  return typeMap;
}
