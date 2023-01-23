import { mctree } from "@markw65/prettier-plugin-monkeyc";
import { hasProperty } from "./ast";
import {
  VariableStateNode,
  FunctionStateNode,
  LookupDefinition,
  ClassStateNode,
  StateNodeDecl,
  ProgramStateAnalysis,
} from "./optimizer-types";

export function cloneSet<T>(ae: Set<T>) {
  return new Set<T>(ae);
}

export function mergeSet<T>(a: Set<T>, b: Set<T>) {
  b.forEach((event) => a.add(event));
}

export function recordModifiedDecl(
  func: FunctionStateNode,
  decl: VariableStateNode
) {
  if (!func.next_info) {
    func.next_info = { modifiedDecls: new Set(), calledFuncs: new Set() };
  }
  func.next_info.modifiedDecls.add(decl);
  return null;
}

export function recordModifiedDecls(
  func: FunctionStateNode,
  lookupDefs: LookupDefinition[]
) {
  lookupDefs.forEach((lookupDef) =>
    lookupDef.results.forEach((result) => {
      if (result.type === "VariableDeclarator" && result.node.kind === "var") {
        recordModifiedDecl(func, result);
      }
    })
  );
}

export function recordModifiedName(func: FunctionStateNode, name: string) {
  if (!func.next_info) {
    func.next_info = { modifiedDecls: new Set(), calledFuncs: new Set() };
  }
  if (!func.next_info.modifiedNames) {
    func.next_info.modifiedNames = new Set();
  }
  func.next_info.modifiedNames.add(name);
}

export function recordModifiedUnknown(func: FunctionStateNode) {
  if (!func.next_info) {
    func.next_info = { modifiedDecls: new Set(), calledFuncs: new Set() };
  }
  func.next_info.modifiedUnknown = true;
}

export function recordCalledFunc(
  func: FunctionStateNode,
  callee: FunctionStateNode
) {
  if (!func.next_info) {
    func.next_info = { modifiedDecls: new Set(), calledFuncs: new Set() };
  }
  func.next_info.calledFuncs.add(callee);
  return null;
}

export function recordCalledFuncs(
  func: FunctionStateNode,
  callees: FunctionStateNode[]
) {
  callees.forEach((callee) => {
    recordCalledFunc(func, callee);
  });
}

export function functionMayModify(
  state: ProgramStateAnalysis,
  func: FunctionStateNode,
  decl: VariableStateNode
) {
  const info = func.info;
  if (info === false) return false;
  if (!info || info.modifiedUnknown) return true;
  if (info.resolvedDecls) {
    return info.resolvedDecls.has(decl);
  }
  if (info.modifiedNames?.has(decl.name)) return true;
  if (info.modifiedDecls.has(decl)) return true;
  const visited = new Set<FunctionStateNode>();
  const resolved = new Set<VariableStateNode>();
  const resolveDecls = (f: FunctionStateNode): boolean => {
    if (f.info === false || visited.has(f)) return true;
    if (!f.info) return false;
    if (f.info.modifiedUnknown) {
      info.modifiedUnknown = true;
      return false;
    }
    if (f.info.modifiedNames) {
      if (info.modifiedNames) {
        mergeSet(info.modifiedNames, f.info.modifiedNames);
      } else {
        info.modifiedNames = cloneSet(f.info.modifiedNames);
      }
    }
    mergeSet(resolved, f.info.modifiedDecls);
    visited.add(f);
    const q = true;
    if (
      q &&
      f.info.callsExposed &&
      state.exposed &&
      !Object.keys(state.exposed).every(
        (key) =>
          !state.allFunctions[key] ||
          state.allFunctions[key].every(resolveDecls)
      )
    ) {
      return false;
    }
    return Array.from(f.info.calledFuncs).every(resolveDecls);
  };
  if (resolveDecls(func)) {
    info.resolvedDecls = resolved;
    return resolved.has(decl);
  }
  return true;
}

export function findCallees(lookupDefs: LookupDefinition[]) {
  const decls = lookupDefs.reduce<StateNodeDecl[] | null>(
    (decls, r) => (decls ? decls.concat(r.results) : r.results),
    null
  );
  return (
    decls &&
    decls.filter((decl): decl is FunctionStateNode =>
      decl ? decl.type === "FunctionDeclaration" : false
    )
  );
}

export function findCalleesForNew(lookupDefs: LookupDefinition[]) {
  const initializer = (decl: ClassStateNode): StateNodeDecl[] | null => {
    if (hasProperty(decl.decls, "initialize")) {
      return decl.decls["initialize"];
    }
    if (decl.superClass && decl.superClass !== true) {
      return decl.superClass.reduce<StateNodeDecl[] | null>((cur, cls) => {
        const init = initializer(cls);
        if (init) {
          if (!cur) return init;
          return cur.concat(init);
        }
        return cur;
      }, null);
    }
    return null;
  };
  return lookupDefs.flatMap((r) =>
    r.results
      .filter(
        (decl): decl is ClassStateNode => decl.type === "ClassDeclaration"
      )
      .flatMap(initializer)
      .filter((decl): decl is FunctionStateNode =>
        decl ? decl.type === "FunctionDeclaration" : false
      )
  );
}

export function findCalleesByNode(
  state: ProgramStateAnalysis,
  callee: mctree.Expression
) {
  const name =
    callee.type === "Identifier"
      ? callee.name
      : callee.type === "MemberExpression" && !callee.computed
      ? callee.property.name
      : null;
  if (!name) return null;
  return (
    (hasProperty(state.allFunctions, name) && state.allFunctions[name]) || null
  );
}
