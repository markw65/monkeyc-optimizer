import { formatAstLongLines, popRootNode, pushRootNode } from "src/api";
import { RootStateNode } from "src/control-flow";
import { buildTypeInfo } from "src/type-flow";
import { ProgramStateAnalysis, ProgramStateNode } from "../optimizer-types";
import { couldBeWeak } from "./could-be";
import {
  DependencyFlags,
  DependencyMap,
  InterpState,
  TypeMap,
  evaluate,
} from "./interp";
import { subtypeOf } from "./sub-type";
import { display } from "./types";
import { log } from "src/logger";

export async function analyze_module_types(state: ProgramStateAnalysis) {
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

  const typeMap: TypeMap = new Map();
  const moduleMap = new Map<RootStateNode, InterpState>();
  const dependencies = new Map<RootStateNode, DependencyMap>();
  for (const module of modulesSet) {
    modulesSet.delete(module);
    const istate = buildTypeInfo(state, module, false);
    await log();
    if (istate?.typeMap) {
      moduleMap.set(module, istate);
      istate.dependencies?.forEach((flags, other) => {
        if (other === module) return;
        const depMap = dependencies.get(other);
        if (depMap) {
          depMap.set(module, (depMap.get(module) ?? 0) | flags);
        } else {
          dependencies.set(other, new Map([[module, flags]]));
        }
      });
      let changes = false;
      let promise: Promise<unknown> | null = null;
      istate.typeMap?.forEach((value, key) => {
        const old = typeMap.get(key);
        if (!old) {
          changes = true;
        } else if (!subtypeOf(value, old)) {
          if (promise) return;
          promise = formatAstLongLines(key).then((nodeStr) => {
            throw new Error(
              `New type for ${nodeStr} was not a subtype. Old: ${display(
                old
              )} vs New: ${display(value)}`
            );
          });
        } else if (!changes && !subtypeOf(old, value)) {
          changes = true;
        }
        typeMap.set(key, value);
      });
      promise && (await promise);
      if (changes) {
        const depMap = dependencies.get(module);
        depMap?.forEach((flags, other) => {
          if (flags & DependencyFlags.Type) {
            modulesSet.add(other);
          }
        });
      }
    }
  }

  rootList.push(...Object.values(state.allFunctions).flat());
  for (const root of rootList) {
    const istate = moduleMap.get(root) ?? buildTypeInfo(state, root, false);
    if (istate) {
      istate.typeChecker = typeChecker;
      istate.checkTypes = checkTypes;
      if (root.nodes) {
        const saved = istate.state.stack;
        root.nodes.forEach((stack, node) => {
          istate.state.stack = stack.slice();
          pushRootNode(istate.state.stack, root);
          evaluate(istate, node);
          popRootNode(istate.state.stack, root);
        });
        istate.state.stack = saved;
      } else {
        pushRootNode(istate.state.stack, root);
        evaluate(istate, root.node!);
        popRootNode(istate.state.stack, root);
      }
      istate.typeMap?.forEach((value, key) => typeMap.set(key, value));
    }
  }
  return typeMap;
}
