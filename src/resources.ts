import { mctree } from "@markw65/prettier-plugin-monkeyc";
import { Program } from "@markw65/prettier-plugin-monkeyc/build/src/estree-types";
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
          visit(e, null);
          break;
        case "group":
          if (pname !== "settings" /* && pname !== "resources" */) {
            error(e);
            break;
          }
          visit(e, null);
          break;

        case "fitField":
          if (pname !== "fitContributions" && pname !== "resources") {
            error(e);
            break;
          }
          visit(e, null);
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
  ast: Program,
  resources: Record<string, JungleResourceMap>
) {
  Object.entries(resources).forEach(([barrel, resourceMap]) => {
    const rezModules: Record<string, xmlUtil.Element[]> = {
      Drawables: [],
      Fonts: [],
      JsonData: [],
      Layouts: [],
      Menus: [],
      Properties: [],
      Strings: [],
    };
    Object.values(resourceMap).forEach((rez) => {
      if (!rez || !(rez instanceof xmlUtil.Document)) return;
      visit_resources(rez.body.elements, null, (e, s) => {
        if (!s) return;
        if (!hasProperty(rezModules, s)) return;
        rezModules[s].push(e);
      });
    });
    const outerLoc = ast.loc && { ...ast.loc };
    const makeModule = (m: string): mctree.ModuleDeclaration => ({
      type: "ModuleDeclaration",
      id: { type: "Identifier", name: m },
      body: { type: "BlockStatement", body: [] },
      loc: outerLoc,
    });
    let body: (mctree.Statement | mctree.ImportStatement)[] = ast.body;

    if (barrel !== "") {
      const module = makeModule(barrel);
      body.push(module);
      body = module.body.body;
    }

    const rez = makeModule("Rez");
    body.push(rez);
    body = rez.body.body;

    Object.entries(rezModules).forEach(([m, elements]) => {
      const module = makeModule(m);
      body.push(module);
      elements.forEach(
        (e) =>
          e.attr.id &&
          module.body.body.push({
            type: "VariableDeclaration",
            declarations: [
              {
                type: "VariableDeclarator",
                kind: "var",
                id: { type: "Identifier", name: e.attr.id, loc: e.loc },
                loc: e.loc,
              },
            ],
            kind: "var",
            loc: e.loc,
          })
      );
    });
  });
}
