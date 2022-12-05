import { mctree } from "@markw65/prettier-plugin-monkeyc";
import { hasProperty } from "./ast";
import { JungleResourceMap } from "./jungles";
import { xmlUtil } from "./sdk-util";

type Visit = (
  e: xmlUtil.Element,
  module: string | null,
  parent: xmlUtil.Element | null
) => void;

type Visitor = {
  visit?: Visit;
  error?: (node: xmlUtil.Element, parent: string | null) => void;
  pre?: (node: xmlUtil.Content) => boolean | null | undefined | void;
  post?: (node: xmlUtil.Content) => void;
};
/*
 * This is unavoidably ad-hoc. Garmin has arbitrary rules for how
 * resources can be nested, which we need to mimic here.
 */
export function visit_resources(
  elements: xmlUtil.Content[],
  parent: xmlUtil.Element | null,
  v: Visitor | Visit
) {
  const visitor: Visitor =
    typeof v === "function"
      ? {
          visit: v,
        }
      : v;
  const pname = parent ? parent.name : null;
  const error = (e: xmlUtil.Element) =>
    visitor.error && visitor.error(e, pname);
  const visit = (e: xmlUtil.Element, module: string | null) =>
    visitor.visit && visitor.visit(e, module, parent);
  elements.forEach((e) => {
    if (visitor.pre ? visitor.pre(e) === false : e.type !== "element") {
      return;
    }
    if (e.type == "element") {
      switch (e.name) {
        // <resources> can contain any of the resource lists (except
        // another resources), and any of their contents
        case "resources":
          if (parent) {
            error(e);
            break;
          }
          e.children && visit_resources(e.children, e, visitor);
          break;

        // Each of these is a list that can contain certain kinds of resource.
        // They can only occur at the top level, or under a <resources> list.
        case "strings":
        case "fonts":
        case "animations":
        case "bitmaps":
        case "layouts":
        case "menus":
        case "drawables":
        case "properties":
        case "settings":
        case "fitContributions":
        case "jsonDataResources":
        case "complications":
          if (pname && pname !== "resources") {
            error(e);
            break;
          }
          visit_resources(xmlUtil.elementKids(e), e, visitor);
          break;

        // These are the resources themselves. Some can occur at top level; most
        // are restricted to <resources> or one or more of the specific lists above
        case "string":
          if (pname !== "strings" && pname !== "resources") {
            error(e);
            break;
          }
          visit(e, "Strings");
          break;
        case "font":
          if (pname !== "fonts" && pname !== "resources") {
            error(e);
            break;
          }
          visit(e, "Fonts");
          break;
        case "animation":
          if (pname !== "animations" && pname !== "resources") {
            error(e);
            break;
          }
          visit(e, "Drawables");
          break;
        case "menu":
        case "menu2":
        case "checkbox-menu":
        case "action-menu":
          if (pname && pname !== "menus" && pname !== "resources") {
            error(e);
            break;
          }
          visit(e, "Menus");
          break;
        case "bitmap":
          if (
            pname !== "bitmaps" &&
            pname !== "drawables" &&
            pname !== "resources"
          ) {
            error(e);
            break;
          }
          visit(e, "Drawables");
          break;

        case "layout":
          if (pname && pname !== "layouts" && pname !== "resources") {
            error(e);
            break;
          }
          visit(e, "Layouts");
          break;
        case "drawable-list":
          if (pname && pname !== "drawables" && pname !== "resources") {
            error(e);
            break;
          }
          visit(e, "Drawables");
          break;
        case "property":
          if (pname !== "properties" && pname !== "resources") {
            error(e);
            break;
          }
          visit(e, "Properties");
          break;
        case "setting":
          if (pname !== "settings" && pname !== "resources") {
            error(e);
            break;
          }
          visit(e, "Settings");
          break;
        case "group":
          if (pname !== "settings" /* && pname !== "resources" */) {
            error(e);
            break;
          }
          visit(e, "Settings");
          break;

        case "fitField":
          if (pname !== "fitContributions" && pname !== "resources") {
            error(e);
            break;
          }
          visit(e, "FitFields");
          break;
        case "jsonData":
          if (pname && pname != "jsonDataResources" && pname !== "resources") {
            error(e);
            break;
          }
          visit(e, "JsonData");
          break;
        case "build":
          if (pname && pname !== "resources") {
            error(e);
            break;
          }
          visit(e, null);
          break;
      }
    }
    if (visitor.post) visitor.post(e);
  });
}

export function add_resources_to_ast(
  ast: mctree.Program,
  resources: Record<string, JungleResourceMap>,
  manifestXML?: xmlUtil.Document
) {
  const modules = {
    Drawables: true,
    Fonts: true,
    JsonData: true,
    Layouts: true,
    Menus: true,
    Strings: true,
    Properties: false,
    Settings: false,
    FitFields: false,
  };
  const outerLoc = ast.loc && { ...ast.loc };
  const makeModule = (m: string): mctree.ModuleDeclaration => ({
    type: "ModuleDeclaration",
    id: { type: "Identifier", name: m },
    body: { type: "BlockStatement", body: [] },
    loc: outerLoc,
  });
  const makeImport = <T extends "ImportModule" | "Using">(
    type: T,
    module: string,
    as?: string | null
  ) => {
    const id = makeScopedName(module)!;
    return type === "Using" && as
      ? { type, id, as: makeIdentifier(as) }
      : { type, id };
  };

  ast.body.push(
    makeImport("ImportModule", "Toybox.Lang"),
    makeImport("Using", "Toybox.WatchUi"),
    makeImport("Using", "Toybox.WatchUi", "Ui"),
    makeImport("Using", "Toybox.Graphics"),
    makeImport("Using", "Toybox.Graphics", "Gfx")
  );

  Object.entries(resources).forEach(([barrel, resourceMap]) => {
    let body: (mctree.Statement | mctree.ImportStatement)[] = ast.body;

    if (barrel !== "") {
      const module = makeModule(barrel);
      body.push(module);
      body = module.body.body;
    }

    const rez = makeModule("Rez");
    body.push(rez);
    const hiddenRez = makeModule("*Rez*");
    rez.body.body.push(hiddenRez);
    if (manifestXML && manifestXML.body instanceof xmlUtil.Nodes) {
      manifestXML.body
        .children("iq:application")
        .elements.forEach((e) => add_one_resource(rez, e));
    }

    const rezModules = Object.fromEntries(
      Object.entries(modules).map(([moduleName, isPublic]) => {
        const module = makeModule(moduleName);
        (isPublic ? rez : hiddenRez).body.body.push(module);
        return [moduleName, module];
      })
    );
    Object.values(resourceMap).forEach((rez) => {
      if (!rez || rez.body instanceof Error) return;
      visit_resources(rez.body.elements, null, (e, s) => {
        if (!s) return;
        if (!hasProperty(rezModules, s)) return;
        const module = rezModules[s];

        add_one_resource(module, e);
      });
    });
  });
}

function makeIdentifier(
  name: string,
  loc?: mctree.SourceLocation | null | undefined
) {
  return wrap({ type: "Identifier", name }, loc);
}

function makeMemberExpression(
  object: mctree.ScopedName,
  property: mctree.Identifier
): mctree.DottedName {
  return wrap(
    {
      type: "MemberExpression",
      object,
      property,
      computed: false,
    },
    object.loc && locRange(object.loc, property.loc!)
  );
}

function makeScopedName(dotted: string, l?: mctree.SourceLocation) {
  const loc = l && adjustLoc(l, 0, l.start.offset - l.end.offset);
  return dotted.split(".").reduce<{
    cur: mctree.ScopedName | null;
    offset: number;
  }>(
    ({ cur, offset }, next) => {
      const id = makeIdentifier(
        next,
        loc && adjustLoc(loc, offset, offset + next.length)
      );
      if (!cur) {
        cur = id;
      } else {
        cur = makeMemberExpression(cur, id);
      }
      offset += next.length + 1;
      return { cur, offset };
    },
    { cur: null, offset: 0 }
  ).cur;
}

function visit_resource_refs(e: xmlUtil.Element) {
  const result: Array<mctree.ScopedName> = [];
  const stringToScopedName = (
    element: string,
    id: string | null,
    dotted: string,
    l: mctree.SourceLocation
  ) => {
    const match = dotted.match(/^(@)?([\w_$]+\s*\.\s*)*[\w_$]+$/);
    if (!match) return;
    let offset = 0;
    if (match[1]) {
      offset = 1;
    } else if (
      (element === "drawable" && id === "class") ||
      (element === "iq:application" && id === "entry")
    ) {
      // nothing to do
    } else {
      return;
    }
    const dn = makeScopedName(
      dotted.substring(offset),
      adjustLoc(l, offset, 0)
    );
    if (dn) result.push(dn);
  };

  visit_resources([e], null, {
    pre(node: xmlUtil.Content) {
      if (node.type === "element") {
        Object.values(node.attr).forEach((attr) => {
          if (!attr || !attr.value.loc) return;
          const loc = adjustLoc(attr.value.loc!);
          attr &&
            stringToScopedName(
              node.name,
              attr.name.value,
              attr.value.value,
              loc
            );
        });
        if (
          node.children &&
          node.children.length === 1 &&
          node.children[0].type === "chardata"
        ) {
          stringToScopedName(
            node.name,
            null,
            node.children[0].value,
            node.children[0].loc!
          );
        }
        return;
      }
    },
  });
  return result;
}

function wrap<T extends mctree.Node>(
  node: T,
  loc?: mctree.SourceLocation | null
): T {
  if (loc) {
    node.loc = loc;
    node.start = loc.start.offset;
    node.end = loc.end.offset;
  }
  return node;
}

function locRange(start: mctree.SourceLocation, end: mctree.SourceLocation) {
  return {
    source: start.source || end.source,
    start: start.start,
    end: end.end,
  };
}

function adjustLoc(loc: xmlUtil.SourceLocation, start = 1, end = -1) {
  /* Attributes are quoted, so skip the quotes */
  return {
    source: loc.source,
    start: {
      offset: loc.start.offset + start,
      line: loc.start.line,
      column: loc.start.column + start,
    },
    end: {
      offset: loc.end.offset + end,
      line: loc.end.line,
      column: loc.end.column + end,
    },
  } as const;
}

function add_one_resource(
  module: mctree.ModuleDeclaration,
  e: xmlUtil.Element
) {
  let id: xmlUtil.Attribute | undefined;
  let func: (() => mctree.Declaration | null) | undefined;

  const varDecl = (): mctree.VariableDeclaration => {
    const loc = id && adjustLoc(id.value.loc!);
    return wrap(
      {
        type: "VariableDeclaration",
        declarations: [
          wrap(
            {
              type: "VariableDeclarator",
              kind: "var",
              id: makeIdentifier(id ? id.value.value : "*invalid*", loc),
              init,
            },
            loc
          ),
        ],
        kind: "var",
      },
      loc
    );
  };

  const classDecl = (parent: string): mctree.ClassDeclaration | null => {
    if (!id) return null;
    const loc = id.value.loc;
    const items: mctree.ClassElement[] = init
      ? [{ type: "ClassElement", item: varDecl(), loc }]
      : [];
    return {
      type: "ClassDeclaration",
      body: { type: "ClassBody", body: items, loc },
      id: makeIdentifier(id.value.value, loc),
      superClass: makeScopedName(parent),
      loc,
    };
  };

  switch (e.name) {
    case "font":
    case "string":
    case "jsonData":
    case "animation":
    case "bitmap":
    case "layout":
    case "drawable-list":
    case "property":
    case "fitField":
      id = e.attr.id;
      func = varDecl;
      break;
    case "menu":
      id = e.attr.id;
      func = () => classDecl("Ui.Menu");
      break;
    case "menu2":
      id = e.attr.id;
      func = () => classDecl("Ui.Menu2");
      break;
    case "checkbox-menu":
      id = e.attr.id;
      func = () => classDecl("Ui.CheckboxMenu");
      break;
    case "action-menu":
      id = e.attr.id;
      func = () => classDecl("Ui.Menu2");
      break;

    case "setting":
    case "group":
      func = varDecl;
      break;

    case "iq:application":
      func = varDecl;
      break;
  }
  if (!func) return;
  const elements = visit_resource_refs(e);
  const init = elements.length
    ? ({ type: "ArrayExpression", elements } as const)
    : undefined;
  if (!id) {
    if (!init) return;
  }
  const item = func();
  if (item) {
    module.body.body.push(item);
  }
}
