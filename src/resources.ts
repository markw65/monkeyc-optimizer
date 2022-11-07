import { mctree } from "@markw65/prettier-plugin-monkeyc";
import { Program } from "@markw65/prettier-plugin-monkeyc/build/src/estree-types";
import { hasProperty } from "./ast";
import { JungleResourceMap } from "./jungles";
import { xmlUtil } from "./sdk-util";

/*
 * This is unavoidably ad-hoc. Garmin has arbitrary rules for how
 * resources can be nested, which we need to mimic here.
 */
export function visit_resources(
  elements: xmlUtil.Element[],
  parent: string | null,
  visitor: (e: xmlUtil.Element, module: string | null) => void,
  error: (e: xmlUtil.Element, parent: string | null) => void
) {
  elements.forEach((e) => {
    switch (e.name) {
      // <resources> can contain any of the resource lists (except
      // another resources), and any of their contents
      case "resources":
        if (parent) {
          error(e, parent);
          return;
        }
        visit_resources(xmlUtil.elementKids(e), "resources", visitor, error);
        return;

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
        if (parent && parent !== "resources") {
          error(e, parent);
          return;
        }
        visit_resources(xmlUtil.elementKids(e), e.name, visitor, error);
        return;

      // These are the resources themselves. Some can occur at top level; most
      // are restricted to <resources> or one or more of the specific lists above
      case "string":
        if (parent !== "strings" && parent !== "resources") {
          error(e, parent);
          return;
        }
        visitor(e, "Strings");
        return;
      case "font":
        if (parent !== "fonts" && parent !== "resources") {
          error(e, parent);
          return;
        }
        visitor(e, "Fonts");
        return;
      case "animation":
        if (parent !== "animations" && parent !== "resources") {
          error(e, parent);
          return;
        }
        visitor(e, "Drawables");
        return;
      case "menu":
      case "menu2":
      case "checkbox-menu":
      case "action-menu":
        if (parent && parent !== "menus" && parent !== "resources") {
          error(e, parent);
          return;
        }
        visitor(e, "Menus");
        return;
      case "bitmap":
        if (
          parent !== "bitmaps" &&
          parent !== "drawables" &&
          parent !== "resources"
        ) {
          error(e, parent);
          return;
        }
        visitor(e, "Drawables");
        return;

      case "layout":
        if (parent && parent !== "layouts" && parent !== "resources") {
          error(e, parent);
          return;
        }
        visitor(e, "Layouts");
        return;
      case "drawable-list":
        if (parent && parent !== "drawables" && parent !== "resources") {
          error(e, parent);
          return;
        }
        visitor(e, "Drawables");
        return;
      case "property":
        if (parent !== "properties" && parent !== "resources") {
          error(e, parent);
          return;
        }
        visitor(e, "Properties");
        return;
      case "setting":
        if (parent !== "settings" && parent !== "resources") {
          error(e, parent);
          return;
        }
        visitor(e, null);
        return;
      case "group":
        if (parent !== "settings" /* && parent !== "resources" */) {
          error(e, parent);
          return;
        }
        visitor(e, null);
        return;

      case "fitField":
        if (parent !== "fitContributions" && parent !== "resources") {
          error(e, parent);
          return;
        }
        visitor(e, null);
        return;
      case "jsonData":
        if (parent && parent != "jsonDataResources" && parent !== "resources") {
          error(e, parent);
          return;
        }
        visitor(e, "JsonData");
        return;
      case "build":
        if (parent && parent !== "resources") {
          error(e, parent);
          return;
        }
        visitor(e, null);
        return;
    }
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
      visit_resources(
        rez.body.elements,
        null,
        (e, s) => {
          if (!s) return;
          if (!hasProperty(rezModules, s)) return;
          rezModules[s].push(e);
        },
        (_e, _s) => {
          return;
        }
      );
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
