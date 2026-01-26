import { default as MonkeyC, mctree } from "@markw65/prettier-plugin-monkeyc";
import { ParserOptions } from "prettier";
import { diagnostic } from "./api";
import {
  adjustLoc,
  hasProperty,
  locRange,
  makeIdentifier,
  makeMemberExpression,
  makeScopedName,
  traverseAst,
  withLoc,
  wrap,
} from "./ast";
import { JungleResourceMap } from "./jungles";
import { ProgramState } from "./optimizer-types";
import { xmlUtil } from "./sdk-util";

type Visit = (
  e: xmlUtil.Element,
  module: string | null,
  parent: xmlUtil.Element | null
) => void;

type Visitor = {
  visit?: Visit;
  error?: (node: xmlUtil.Element, parent: string | null) => void;
} & xmlUtil.Visitor;

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
    if (e.type === "element") {
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
          if (pname && pname !== "jsonDataResources" && pname !== "resources") {
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
  state: ProgramState | undefined,
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
    const id = makeScopedName(module);
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

  const barrelName =
    manifestXML &&
    manifestXML.body instanceof xmlUtil.Nodes &&
    manifestXML?.body.children("iq:barrel").attrs()[0]?.module?.value.value;

  const barrelNames = new Set(
    Object.keys(resources)
      .map((k) => k || barrelName)
      .filter((e): e is string => !!e)
  );

  Object.entries(resources).forEach(([barrel, resourceMap]) => {
    let body: (mctree.Statement | mctree.ImportStatement)[] = ast.body;

    if (barrel === "" && barrelName) {
      barrel = barrelName;
    }
    if (barrel !== "") {
      const module = makeModule(barrel);
      body.push(module);
      body = module.body.body;
    }

    const rez = makeModule("Rez");
    body.push(rez);
    const hiddenRez = makeModule("*Rez*");
    rez.body.body.push(hiddenRez);
    if (
      barrel === "" &&
      manifestXML &&
      manifestXML.body instanceof xmlUtil.Nodes
    ) {
      manifestXML.body
        .children("iq:application")
        .elements.forEach((e) =>
          add_one_resource(state, manifestXML, rez, e, barrelNames)
        );
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

        add_one_resource(state, rez, module, e, barrelNames);
      });
    });
  });
}

const drawableSkips: Record<string, Record<string, true> | true> = {
  x: { center: true, left: true, right: true, start: true },
  locX: { center: true, left: true, right: true, start: true },
  y: { center: true, top: true, bottom: true, start: true },
  locY: { center: true, top: true, bottom: true, start: true },
  width: { fill: true },
  height: { fill: true },
  a: { fill: true },
  b: { fill: true },
  color: {},
  corner_radius: {},
  radius: {},
  border_width: {},
  border_color: {},
  foreground: {},
  background: {},
  font: {},
  justification: {},
  identifier: true,
};

function addPositions(base: mctree.Position, pos: mctree.Position) {
  const result = { ...base };
  if (pos.line > 1) {
    result.line += pos.line - 1;
    result.column = pos.column;
  } else {
    result.column += pos.column - 1;
  }
  result.offset += pos.offset;
  return result;
}

function visit_resource_refs(
  state: ProgramState | undefined,
  doc: xmlUtil.Document,
  e: xmlUtil.Element,
  barrelNames: Set<string>
) {
  const result: Array<mctree.Expression> = [];
  const parseArg = (
    name: string,
    loc: mctree.SourceLocation,
    skip?: Record<string, true> | true | null
  ) => {
    let base: mctree.ScopedName | undefined;
    if (name.startsWith("@")) {
      name = name.substring(1);
      loc = adjustLoc(loc, 1, 0);
      if (barrelNames.size) {
        const dot = name.indexOf(".");
        if (dot > 0 && dot < name.length - 1) {
          const start = name.substring(0, dot);
          if (barrelNames.has(start)) {
            base = makeScopedName(`${start}.Rez`, loc);
            loc = adjustLoc(loc, dot + 1, 0);
            name = name.substring(dot + 1);
          }
        }
      }
    }
    if (
      skip === true ||
      hasProperty(skip, name) ||
      /^\d+(\.\d+)?%?$/.test(name)
    ) {
      return;
    }
    if (/^([-\w_$]+\s*\.\s*)*[-\w_$]+$/.test(name)) {
      result.push(makeScopedName(name, loc, base));
      return;
    }
    // We wrap the expression in parentheses, so adjust
    // the start position by 1 character to compensate
    // for the opening '('
    const startPos = adjustLoc(loc, -1, 0).start;
    try {
      const expr = MonkeyC.parsers.monkeyc.parse(`(${name})`, {
        filepath: loc.source || undefined,
        singleExpression: true,
      } as ParserOptions<mctree.Node> & {
        singleExpression?: boolean;
      }) as mctree.Expression;
      traverseAst(expr, (node) => {
        if (node.loc) {
          node.loc = {
            source: node.loc.source,
            start: addPositions(startPos, node.loc.start),
            end: addPositions(startPos, node.loc.end),
          };
          node.start = (node.start || 0) + startPos.offset;
          node.end = (node.end || 0) + startPos.offset;
        }
      });
      result.push(expr);
    } catch (ex) {
      if (state) {
        const check = state.config?.checkInvalidSymbols;
        if (check !== "OFF" && ex instanceof Error) {
          const error = ex as Error & { location?: mctree.SourceLocation };
          if (error.location) {
            const location = {
              source: error.location.source,
              start: addPositions(startPos, error.location.start),
              end: addPositions(startPos, error.location.end),
            };
            diagnostic(
              state,
              { type: "Identifier", loc: location, name: "" },
              ex.message,
              check || "WARNING"
            );
          }
        }
      }
    }
  };
  const stringToScopedName = (
    element: xmlUtil.Element,
    id: string | null,
    dotted: string,
    l: mctree.SourceLocation
  ) => {
    dotted = doc.processRefs(dotted);
    if (dotted.startsWith("@")) {
      return parseArg(dotted, l);
    }
    if (id === "personality") {
      const elems = dotted.match(/\s+|\S+/g);
      elems?.reduce(
        (loc, name) => {
          if (/\s/.test(name)) {
            const newLines = name.match(/\r\n|[\r\n]/g);
            if (newLines?.length) {
              loc.start.line += newLines.length;
              loc.start.column = 1;
              loc.start.offset += name.length;
              name = name.replace(/^.*(\r\n|[\r\n])(.*)$/, "$2");
              loc.start.offset -= name.length;
            }
          } else {
            const colonPos = name.indexOf(":");
            const barrel = colonPos < 0 ? "" : name.slice(0, colonPos) + ".";
            name = name.slice(colonPos + 1);
            const base = makeScopedName(`${barrel}Rez.Styles`);
            const idLoc = adjustLoc(loc, colonPos + 1, 0);
            idLoc.end = { ...idLoc.start };
            idLoc.end.column += name.length;
            idLoc.end.offset += name.length;
            const id = makeIdentifier(name, idLoc);
            result.push(makeMemberExpression(withLoc(base, id, false), id));
          }
          return adjustLoc(loc, name.length, 0);
        },
        adjustLoc(l, 0, 0)
      );
      return;
    }
    if (
      /^\s*(true|false|null|NaN|(0x|#)[0-9a-f]+|[-+]?\d+%?)\s*$/i.test(dotted)
    ) {
      return;
    }
    switch (element.name) {
      case "param":
        if (id === null) {
          const name = element.attr.name?.value.value;
          parseArg(
            dotted,
            l,
            name && hasProperty(drawableSkips, name)
              ? drawableSkips[name]
              : null
          );
        }
        return;
      case "drawable":
        if (id === "class") {
          parseArg(dotted, l);
        } else if (id === "id" && !element.attr.class) {
          if (/^\w+$/.test(dotted)) {
            const base = makeScopedName(`Rez.Drawables`);
            const idLoc = adjustLoc(l, 0, 0);
            const id = makeIdentifier(dotted, idLoc);
            result.push(makeMemberExpression(withLoc(base, id, false), id));
          }
        }
        return;
      case "shape":
      case "bitmap":
      case "drawable-list":
      case "text-area":
      case "label":
        if (id && hasProperty(drawableSkips, id)) {
          parseArg(dotted, l, drawableSkips[id]);
        }
        return;
      case "iq:application":
        if (id === "entry") {
          parseArg(dotted, l);
        }
        return;
      default:
        return;
    }
  };

  xmlUtil.visit_xml([e], {
    pre(node: xmlUtil.Content) {
      if (node.type !== "element") return false;
      Object.values(node.attr).forEach((attr) => {
        if (!attr || !attr.value.loc) return;
        const loc = adjustLoc(attr.value.loc!);
        stringToScopedName(node, attr.name.value, attr.value.value, loc);
      });
      const content = doc.textContent(node);
      if (content) {
        switch (node.name) {
          case "string":
          case "jsonData":
            return false;
          default:
            stringToScopedName(
              node,
              null,
              content,
              locRange(
                node.children![0].loc!,
                node.children![node.children!.length - 1].loc!
              )
            );
            return false;
        }
      }
      return;
    },
  });
  return result;
}

function add_one_resource(
  state: ProgramState | undefined,
  doc: xmlUtil.Document,
  module: mctree.ModuleDeclaration,
  e: xmlUtil.Element,
  barrelNames: Set<string>
) {
  let id: xmlUtil.Attribute | undefined;
  let func: (() => mctree.Declaration | null) | undefined;

  const makeVarDecl = (
    id: xmlUtil.Attribute | undefined,
    outer: xmlUtil.Element["loc"]
  ): mctree.VariableDeclaration => {
    const loc = id && adjustLoc(id.value.loc!);
    const declarations: mctree.VariableDeclarator[] = [];

    if (id) {
      declarations.push({
        type: "VariableDeclarator",
        kind: "var",
        id: {
          type: "BinaryExpression",
          operator: "as",
          left: makeIdentifier(id.value.value, loc),
          right: {
            type: "TypeSpecList",
            ts: [
              {
                type: "TypeSpecPart",
                name: makeScopedName(
                  (state?.sdkVersion ?? 0) >= 7000000
                    ? "Toybox.Lang.ResourceId"
                    : "Toybox.Lang.Symbol"
                ),
              },
            ],
          },
        },
      });
    }
    if (init) {
      declarations.push({
        type: "VariableDeclarator",
        kind: "var",
        id: makeIdentifier("*invalid*"),
        init,
      });
    }

    return wrap(
      {
        type: "VariableDeclaration",
        declarations: declarations.map((d) => wrap(d, outer)),
        kind: "var",
      },
      outer
    );
  };

  const varDecl = () => makeVarDecl(id, e.loc);

  const classDecl = (parent: string): mctree.ClassDeclaration | null => {
    if (!id) return null;
    const loc = id.value.loc;
    const items: mctree.ClassElement[] = init
      ? [
          {
            type: "ClassElement",
            item: makeVarDecl(undefined, init.loc),
            loc: e.loc,
          },
        ]
      : [];
    items.push({
      type: "ClassElement",
      item: {
        type: "FunctionDeclaration",
        id: makeIdentifier("initialize", loc),
        body: null,
        params: [],
        loc: e.loc,
      },
    });
    return {
      type: "ClassDeclaration",
      body: { type: "ClassBody", body: items, loc: e.loc },
      id: makeIdentifier(id.value.value, loc),
      superClass: makeScopedName(parent),
      loc: e.loc,
    };
  };

  const layoutDecl = (): mctree.FunctionDeclaration | null => {
    if (!id) return null;
    const loc = id.value.loc;
    const items: mctree.Statement[] = init
      ? [makeVarDecl(undefined, init.loc)]
      : [];
    return {
      type: "FunctionDeclaration",
      body: { type: "BlockStatement", body: items, loc: e.loc },
      id: makeIdentifier(id.value.value, loc),
      params: [
        {
          type: "BinaryExpression",
          operator: "as",
          left: makeIdentifier("dc"),
          right: {
            type: "TypeSpecList",
            ts: [
              {
                type: "TypeSpecPart",
                name: makeScopedName("Graphics.Dc"),
              },
            ],
          },
        },
      ],
      returnType: {
        type: "UnaryExpression",
        operator: " as",
        prefix: true,
        argument: {
          type: "TypeSpecList",
          ts: [
            {
              type: "TypeSpecPart",
              name: makeScopedName("$.Toybox.Lang.Array"),
              generics: [
                {
                  type: "TypeSpecList",
                  ts: [
                    {
                      type: "TypeSpecPart",
                      name: makeScopedName("$.Toybox.WatchUi.Drawable"),
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
      loc: e.loc,
    };
  };

  switch (e.name) {
    case "font":
    case "string":
    case "jsonData":
    case "animation":
    case "bitmap":
    case "drawable-list":
    case "property":
    case "fitField":
      id = e.attr.id;
      func = varDecl;
      break;
    case "layout":
      id = e.attr.id;
      func = layoutDecl;
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
  const elements = visit_resource_refs(state, doc, e, barrelNames);
  const startLoc = elements[0]?.loc;
  const endLoc = elements[elements.length - 1]?.loc;
  const init = elements.length
    ? wrap<mctree.ArrayExpression>(
        { type: "ArrayExpression", elements },
        startLoc && endLoc && locRange(startLoc, endLoc)
      )
    : undefined;
  if (!id) {
    if (!init) return;
  }
  const item = func();
  if (item) {
    module.body.body.push(item);
  }
}
