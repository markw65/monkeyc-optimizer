import { mctree } from "@markw65/prettier-plugin-monkeyc";
import assert from "node:assert";
import {
  collectNamespaces,
  findUsingForNode,
  formatScopedName,
  lookupNext,
} from "../api";
import { makeIdentifier, makeScopedName, withLocDeep } from "../ast";
import {
  ModuleStateNode,
  ProgramStateAnalysis,
  ProgramStateStack,
} from "../optimizer-types";

export function minimizeModules(
  ast: mctree.Program,
  state: ProgramStateAnalysis
) {
  const { pre, post } = state;
  try {
    const replacementMap = new Map<
      mctree.ScopedName,
      { module: ModuleStateNode; addImport: boolean }
    >();
    const conflictingNames = new Set<string>();
    state.pre = function (node) {
      if (this.inType) return null;
      switch (node.type) {
        case "ModuleDeclaration":
        case "ClassDeclaration":
        case "FunctionDeclaration":
          return ["body"];
        case "Using":
          conflictingNames.add(
            node.as?.name ??
              (node.id.type === "Identifier"
                ? node.id.name
                : node.id.property.name)
          );
          return [];
        case "ImportModule":
          conflictingNames.add(
            node.id.type === "Identifier" ? node.id.name : node.id.property.name
          );
          return [];
        case "Identifier":
        case "MemberExpression": {
          let current = node as mctree.Expression;
          const parts: mctree.DottedMemberExpression[] = [];
          while (current.type === "MemberExpression" && !current.computed) {
            parts.unshift(current);
            current = current.object;
          }
          if (
            current.type !== "Identifier" &&
            current.type !== "ThisExpression"
          ) {
            break;
          }
          let toReplace: mctree.ScopedName | null = null;
          let module: ModuleStateNode | null = null;
          let addImport = false;
          let [, results] = this.lookupValue(current, null);
          let i = 0;
          for (
            ;
            results &&
            results.length === 1 &&
            results[0].results.length === 1 &&
            (results[0].results[0].type === "Program" ||
              results[0].results[0].type === "ClassDeclaration" ||
              results[0].results[0].type === "ModuleDeclaration");
            i++
          ) {
            if (
              current.type === "Identifier" &&
              results[0].results[0].type === "ModuleDeclaration" &&
              isImportCandidate(results[0].results[0], this.stack)
            ) {
              const directResults = i
                ? this.lookupValue(current, null)
                : results;
              if (
                directResults &&
                directResults.length === 1 &&
                directResults[0].results.length === 1 &&
                directResults[0].results[0] === results[0].results[0]
              ) {
                // we would find the same thing if we just looked up
                // current directly.
                toReplace = (i ? parts[i - 1] : current) as mctree.ScopedName;
                module = results[0].results[0];
                if (
                  findUsingForNode(
                    this,
                    this.stack,
                    this.stack.length - 1,
                    current
                  ) === directResults[0].results[0]
                ) {
                  // we already find it via an import, so we don't need
                  // a new import.
                  addImport = false;
                } else {
                  addImport = true;
                }
              } else {
                toReplace = parts[i - 1] as mctree.ScopedName;
                module = results[0].results[0];
                addImport = true;
              }
            }
            if (i === parts.length) break;
            current = parts[i].property;
            results = lookupNext(this, results, "decls", current);
          }
          if (toReplace) {
            assert(module);
            replacementMap.set(toReplace, { module, addImport });
          } else if (parts.length === 0) {
            assert(node.type === "Identifier");
            conflictingNames.add(node.name);
          } else if (parts[0].object.type === "Identifier") {
            conflictingNames.add(parts[0].object.name);
          }
          return [];
        }
      }
      return null;
    };
    delete state.post;
    collectNamespaces(ast, state);
    const mappedNames = new Map<ModuleStateNode, string>();
    replacementMap.forEach((value, key) => {
      let name: string | undefined;
      if (value.addImport) {
        name = mappedNames.get(value.module);
        if (!name) {
          name = value.module.name;
          for (let i = 0; conflictingNames.has(name); i++) {
            name = `${value.module.name}_${i}`;
          }
          mappedNames.set(value.module, name);
          conflictingNames.add(name);
        }
      } else {
        name = key.type === "Identifier" ? key.name : key.property.name;
      }
      const original = formatScopedName(key);
      const repl = key as unknown as Record<string, unknown>;
      repl.type = "Identifier";
      repl.name = name;
      if (name !== original) {
        repl.original = original;
      }
      delete repl.property;
      delete repl.object;
      delete repl.computed;
    });
    mappedNames.forEach((name, module) => {
      const id = makeScopedName(module.fullName.slice(2));
      const as =
        name !== (id.type === "Identifier" ? id : id.property).name &&
        makeIdentifier(name);
      const using: mctree.Using = withLocDeep(
        as ? { type: "Using", id, as } : { type: "Using", id },
        ast,
        false,
        true
      );
      ast.body.unshift(using);
    });
  } finally {
    state.pre = pre;
    state.post = post;
  }
}

/**
 * There's a bug in garmin's runtime (although the compiler could
 * work around it). See
 *
 *   https://forums.garmin.com/developer/connect-iq/i/bug-reports/referencing-an-imported-module-doesn-t-run-its-parent-s-init
 *
 * What this means is that if a module's parent isn't `globals`
 * and it needs to be initialized, then we can't risk
 * importing it, because the parent module might not get initialized
 * in time.
 */
function isImportCandidate(module: ModuleStateNode, stack: ProgramStateStack) {
  if (module.fullName.startsWith("$.Toybox.")) return true;
  if (module.fullName.startsWith("$.Rez.")) return false;
  if (module.fullName === "$.Rez") {
    // $.Rez can refer to different modules in different scopes in background
    // scope, its globals/BackgroundRez, and in glance scope its
    // globals/GlanceRez. If we "import Rez" though, it will be bound to
    // globals/Rez at compile time.
    //
    // Also, some code runs in multiple contexts, so even though we could
    // determine that Rez.Strings.Foo has background scope, and bind *that* Rez
    // to globals/BackgroundRez (and it would work), it would mean that we
    // pulled the background resources into the foreground scope; costing us
    // memory (much more than we would) save through the import.
    for (let i = stack.length; i--; ) {
      const sn = stack[i].sn;
      if (
        sn.node &&
        "attrs" in sn.node &&
        sn.node.attrs?.attributes?.elements.some(
          (attr) =>
            attr.type === "UnaryExpression" &&
            attr.argument.name.match(/^background|glance$/i)
        )
      ) {
        return false;
      }
    }
  }
  assert(module.stack);
  if (module.stack.length === 1) return true;
  return module.stack.every((elem) => {
    if (!elem.sn.decls) return false;
    if (elem.sn.type === "Program") return true;
    if (elem.sn.type !== "ModuleDeclaration") return false;
    return Object.values(elem.sn.decls).every((decls) =>
      decls.every((decl) => {
        if (decl.type !== "VariableDeclarator") return true;
        if (!decl.node.init) return true;
        if (
          decl.node.init.type === "UnaryExpression" &&
          decl.node.init.operator === ":"
        ) {
          return true;
        }
        if (decl.node.init.type !== "Literal") return false;
        switch (typeof decl.node.init.value) {
          case "boolean":
            return true;
          case "bigint":
            return false;
          case "number":
            return !/[dl]$/i.test(decl.node.init.raw);
          case "object":
            return decl.node.init.value === null;
        }
        return false;
      })
    );
  });
}
