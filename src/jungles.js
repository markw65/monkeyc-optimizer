import * as fs from "fs/promises";
import * as path from "path";
import { parseStringPromise } from "xml2js";
import * as jungle from "../build/jungle.js";
import { hasProperty } from "./api.js";
import { manifestProducts, readManifest } from "./manifest.js";
import { getDeviceInfo, getLanguages } from "./sdk-util.js";
import { globa } from "./util.js";

async function default_jungle() {
  const assignments = [];
  const devices = await getDeviceInfo();
  const languages = await getLanguages();
  const literal = (value) => ({ type: "Literal", value });
  const qname = (name) => ({ type: "QualifiedName", names: name.split(".") });
  const assign = (name, values) =>
    assignments.push({ names: name.split("."), values });
  const rassign = (name, values, base) => {
    assign(name, base ? [qname(name)].concat(values) : values);
  };
  const rezAndLang = (id, rez, base) => {
    if (base) {
      assign(id, [qname(base)]);
    }
    rassign(`${id}.resourcePath`, [literal(rez)], base);

    languages.forEach((l) =>
      rassign(`${id}.lang.${l.id}`, [literal(`${rez}-${l.id}`)], base)
    );
  };
  const done = {};

  assign("base.sourcePath", [literal("./**.mc")]);
  rezAndLang("base", "resources");
  Object.entries(devices).forEach(([deviceId, { deviceFamily }]) => {
    const match = deviceFamily.match(/^(\w+)-\d+x\d+/);
    if (!match) {
      throw new Error(
        `Strange deviceFamily (${deviceFamily}) for device ${deviceId}`
      );
    }
    const shape = match[1];
    if (!hasProperty(done, shape)) {
      rezAndLang(shape, `resources-${shape}`, "base");
      done[shape] = true;
    }
    if (!hasProperty(done, deviceFamily)) {
      rezAndLang(deviceFamily, `resources-${deviceFamily}`, shape);
      done[deviceFamily] = true;
    }
    rezAndLang(deviceId, `resources-${deviceId}`, deviceFamily);
  });
  return process_assignments(assignments, {});
}

function process_assignments(assignments, current) {
  return assignments.reduce((state, a) => {
    const { node, dot, dotnames } = a.names.reduce(
      (r, name) => {
        if (!hasProperty(r.node, name)) r.node[name] = {};
        r.dotnames.push(name);
        r.node = r.node[name];
        if (r.node["."]) {
          r.dot = r.node["."];
          r.dotnames = [];
        }
        return r;
      },
      { node: state, dot: null, dotnames: [] }
    );
    // an assignment to a node overwrites its old value
    Object.keys(node).forEach((k) => delete node[k]);
    const process_list = (values) => {
      for (let i = values.length; i--; ) {
        const v = values[i];
        if (
          v.type == "QualifiedName" &&
          v.names.every((n, i) => n === a.names[i])
        ) {
          values.splice(
            i,
            1,
            ...(dot
              ? dot.map((v) =>
                  v.type == "QualifiedName"
                    ? { ...v, names: v.names.concat(dotnames) }
                    : v
                )
              : [])
          );
        } else if (v.type == "SubList") {
          process_list(v.values);
        }
      }
    };
    process_list(a.values);
    if (
      a.names.length === 1 &&
      a.values.length === 1 &&
      a.values[0].type === "QualifiedName" &&
      a.values[0].names.length === 1
    ) {
      // some older manifests have things like "round_watch"
      // as a product. You can't put that in a jungle file
      // so instead, we identify every round device, and
      // replace round_watch with all the corresponding
      // devices. So we look for assignments of the form
      //   device = $(shape-size)
      // and put all such devices on a `shape`_watch entry
      const match = a.values[0].names[0].match(/^(\w+)-(\w+)$/);
      if (match) {
        const key = `${match[1]}_watch`;
        if (!state[key]) state[key] = { products: [] };
        state[key].products.push(a.names[0]);
      }
    }
    node["."] = a.values;
    return state;
  }, current);
}

function evaluate_locals(assignments) {
  const locals = {};
  while (true) {
    assignments = assignments.filter((a) => {
      if (a.names.length == 1 && a.values.every((v) => typeof v === "string")) {
        locals[a.names[0]] = a.values;
        return false;
      }
      return true;
    });
    if (!Object.keys(locals).length) break;
    const process_list = (values) => {
      for (let i = values.length; i--; ) {
        const v = values[i];
        if (
          v.type == "QualifiedName" &&
          v.names.length == 1 &&
          hasProperty(locals, v.names[0])
        ) {
          values.splice(i, 1, ...locals[v.names[0]]);
        } else if (v.type == "SubList") {
          process_list(v.values);
        }
      }
    };
    assignments.forEach((a) => process_list(a.values));
  }
  return assignments;
}

async function parse_one(file) {
  const [fileName, grammarSource] = Array.isArray(file) ? file : [file, file];
  const source = await fs.readFile(fileName);
  const assignments = jungle.parse(source.toString(), { grammarSource });
  return evaluate_locals(assignments);
}

// Read default.jungle, and all jungles in sources, and
// return a jungle object with all local variables resolved,
// but all qualifier references left unresolved.
async function process_jungles(sources) {
  if (!Array.isArray(sources)) {
    sources = [sources];
  }
  const results = await Promise.all(sources.map(parse_one));
  const state = await default_jungle();
  results.forEach((r) => process_assignments(r, state));
  return state;
}

function resolve_node_list(state, list) {
  for (let i = list.length; i--; ) {
    const v = list[i];
    if (v.type === "QualifiedName") {
      const rep = resolve_node(state, resolve_node_by_path(state, v.names));
      if (Array.isArray(rep)) {
        if (rep.length !== 1 || rep[0].type) {
          resolve_node_list(state, rep);
        }
        list.splice(i, 1, ...rep);
      } else if (rep != null) {
        list[i] = rep;
      } else {
        list.splice(i, 1);
      }
    } else if (v.type === "SubList") {
      resolve_node_list(state, v.values);
    }
  }
  return list;
}

function check_non_leaf_dot(dot, path, i) {
  if (dot.length !== 1 || dot[0].type) {
    throw new Error(
      `'.' node at ${(path || [])
        .slice(0, i + 1)
        .join(".")} should have length 1: ${JSON.stringify(dot)}`
    );
  }
}
// return the resolved node at path
function resolve_node_by_path(state, path) {
  return path.reduce((s, n, i) => {
    if (!s[n] && s["."]) {
      let resolved = resolve_node_list(state, s["."])[0][n];
      if (resolved == null && s["."].every((e) => e.type == "Literal")) {
        // foo = string
        // bar = $(foo.resourcePath)
        // is supposed to work as if you'd left out the (obviously
        // incorrect) ".resourcePath"
        return s;
      }
      check_non_leaf_dot(s["."], path, i);
    }
    return s[n];
  }, state);
}

// fully resolve the given node, and all its children
function resolve_node(state, node) {
  if (node == null || Array.isArray(node)) {
    // an already optimized leaf node
    return node;
  }
  const { ".": dot, ...rest } = node;
  if (dot) {
    const entries = Object.entries(rest);
    resolve_node_list(state, dot);
    if (entries.length) {
      // not a leaf, so dot must have a single element
      check_non_leaf_dot(dot);
      Object.entries(dot[0]).forEach(([k, v]) => {
        node[k] = v;
      });
      entries.forEach(([k, v]) => {
        node[k] = v;
      });
    } else if (dot.length === 1 && !dot[0].type) {
      Object.entries(dot[0]).forEach(([k, v]) => {
        node[k] = v;
      });
    } else {
      return dot;
    }
    delete node["."];
  }
  Object.entries(node).forEach(([key, value]) => {
    node[key] = resolve_node(state, value);
  });
  return node;
}

function resolve_filename(literal, default_source) {
  if (typeof literal === "string") return literal;
  const root = path.dirname(literal.source || default_source);
  return path.resolve(root, literal.value);
}

async function resolve_literals(qualifier, default_source) {
  const resolve_file_list = async (literals) =>
    literals &&
    (
      await Promise.all(
        literals.map(async (v) => {
          if (v.type == "SubList") {
            return resolve_file_list(v.values);
          }
          let resolved = resolve_filename(v, default_source);
          if (/[*?\[\]\{\}]/.test(resolved)) {
            // Jungle files can contain "./**.mc" which is supposed to match
            // any mc file under "./". The standard way to express that
            // is "./**/*.mc", which is what glob expects, so translate.
            resolved = resolved.replace(/[\\\/]\*\*([^\\\/])/g, "/**/*$1");
            const match = await globa(resolved);
            return match.length ? resolved : null;
          } else {
            const stat = await fs.stat(resolved).catch(() => null);
            return stat ? resolved : null;
          }
        })
      )
    ).filter((name) => name != null);

  const resolve_one_file_list = async (base, name) => {
    if (!base[name]) return;
    const result = await resolve_file_list(base[name]);
    if (!result || !result.length) {
      delete base[name];
    } else {
      base[name] = result;
    }
  };

  await resolve_one_file_list(qualifier, "sourcePath");
  await resolve_one_file_list(qualifier, "resourcePath");
  await resolve_one_file_list(qualifier, "barrelPath");
  const lang = qualifier["lang"];
  if (lang) {
    await Promise.all(
      Object.keys(lang).map((key) => resolve_one_file_list(lang, key))
    );
    if (Object.keys(lang).length === 0) delete qualifier["lang"];
  } else {
    delete qualifier["lang"];
  }

  const resolve_literal_list = (base, name) => {
    const literals = base[name];
    if (!literals || !literals.length) return;
    base[name] = literals.map((v) => v.value);
  };
  resolve_literal_list(qualifier, "excludeAnnotations");
  resolve_literal_list(qualifier, "annotations");
}

async function find_build_instructions_in_resource(file) {
  const data = await fs.readFile(file);
  const rez = await parseStringPromise(data).catch(() => ({}));
  if (rez.build && rez.build.exclude) {
    const dir = path.dirname(file);
    const sourceExcludes = rez.build.exclude
      .map((e) => e.$.file)
      .filter((f) => f != null)
      .map((f) => path.resolve(dir, f).replace(/\\/g, "/"));

    const filePatterns = rez.build.exclude
      .map((e) => e.$.dir)
      .filter((f) => f != null)
      .map((f) => path.join(dir, f, "**", "*.mc").replace(/\\/g, "/"));
    if (filePatterns.length) {
      const files = (
        await Promise.all(filePatterns.map((p) => globa(p)))
      ).flat();
      sourceExcludes.push(...files);
    }
    const excludeAnnotations = rez.build.exclude
      .map((e) => e.$.annotation)
      .filter((f) => f != null);
    return { sourceExcludes, excludeAnnotations };
  }
}
async function find_build_instructions(targets) {
  const resourceGroups = {};
  await Promise.all(
    targets.map(async (p) => {
      if (!p.qualifier.resourcePath) return;
      const key = p.qualifier.resourcePath.join(";");
      if (!hasProperty(resourceGroups, key)) {
        resourceGroups[key] = {
          resourcePath: p.qualifier.resourcePath,
          products: [],
        };
        const paths = (
          await Promise.all(
            p.qualifier.resourcePath.map((pattern) =>
              globa(pattern, { mark: true })
            )
          )
        ).flat();

        const sourceExcludes = [];
        const excludeAnnotations = [];
        const resourceFiles = await Promise.all(
          paths.map((path) =>
            path.endsWith("/") ? globa(`${path}**/*.xml`, { mark: true }) : path
          )
        );
        const buildInstructions = await Promise.all(
          resourceFiles
            .flat()
            .filter((file) => !file.endsWith("/"))
            .map((file) => find_build_instructions_in_resource(file))
        );
        buildInstructions
          .filter((i) => i != null)
          .map((i) => {
            if (i.sourceExcludes) sourceExcludes.push(...i.sourceExcludes);
            if (i.excludeAnnotations)
              excludeAnnotations.push(...i.excludeAnnotations);
          });
        if (sourceExcludes.length) {
          p.qualifier.sourceExcludes = sourceExcludes;
        }
        if (excludeAnnotations.length) {
          if (p.qualifier.excludeAnnotations) {
            p.qualifier.excludeAnnotations.push(excludeAnnotations);
          } else {
            p.qualifier.excludeAnnotations = excludeAnnotations;
          }
        }
      }
      resourceGroups[key].products.push(p.product);
    })
  );
}

function identify_optimizer_groups(targets, options) {
  const groups = {};
  let key = 0;
  const ignoreStrOption = (str) =>
    str == null
      ? null
      : str === "*"
      ? "*"
      : Object.fromEntries(str.split(";").map((e) => [e, true]));
  const getStrsWithIgnore = (strs, option) => {
    if (option === "*") {
      return [];
    } else {
      return strs.filter((a) => !hasProperty(option, a));
    }
  };
  const ignoreRegExpOption = (str) => {
    try {
      if (!str) return null;
      return new RegExp(str);
    } catch {
      return null;
    }
  };

  const ignoredExcludeAnnotations = ignoreStrOption(
    options.ignoredExcludeAnnotations
  );
  const ignoredAnnotations = ignoreStrOption(options.ignoredAnnotations);
  const ignoredSourcePathsRe = ignoreRegExpOption(options.ignoredSourcePaths);

  const ignoredSourcePaths = ignoredSourcePathsRe
    ? targets.reduce(
        (state, target) => {
          if (target.qualifier.sourcePath) {
            target.qualifier.sourcePath.forEach((path) => {
              const m = path.match(ignoredSourcePathsRe);
              const key = m ? "key-" + m.slice(1).join("") : path;
              if (!hasProperty(state.keys, key)) {
                state.keys[key] = {};
              }
              state.keys[key][path] = true;
              state.paths[path] = state.keys[key];
            });
          }
          return state;
        },
        { keys: {}, paths: {} }
      ).paths
    : null;

  targets.forEach((target) => {
    let {
      sourcePath,
      sourceExcludes,
      barrelPath,
      excludeAnnotations,
      annotations,
    } = target.qualifier;
    if (excludeAnnotations && ignoredExcludeAnnotations) {
      excludeAnnotations = getStrsWithIgnore(
        excludeAnnotations,
        ignoredExcludeAnnotations
      );
    }
    if (annotations && ignoredAnnotations) {
      annotations = getStrsWithIgnore(annotations, ignoredAnnotations);
    }
    if (ignoredSourcePaths) {
      sourcePath = sourcePath
        .map((path) => Object.keys(ignoredSourcePaths[path]))
        .flat()
        .sort()
        .filter((v, i, a) => i === 0 || v !== a[i - 1]);
    }
    const optimizerConfig = {
      sourcePath,
      sourceExcludes,
      barrelPath,
      excludeAnnotations,
      annotations,
    };

    const serialized = JSON.stringify(
      optimizerConfig,
      Object.keys(optimizerConfig).sort()
    );
    if (!hasProperty(groups, serialized)) {
      groups[serialized] = {
        key: "group" + key.toString().padStart(3, "0"),
        optimizerConfig,
      };
      key++;
    }
    target.group = groups[serialized];
  });
}

export async function get_jungle(jungles, options) {
  options = options || {};
  jungles = jungles
    .split(";")
    .map((jungle) => path.resolve(options.workspace || "./", jungle));
  const state = await process_jungles(jungles);
  // apparently square_watch is an alias for rectangle_watch
  state["square_watch"] = state["rectangle_watch"];
  const manifest_node = resolve_node(
    state,
    resolve_node_by_path(state, ["project", "manifest"])
  );
  if (!manifest_node) throw new Error("No manifest found!");
  const manifest = resolve_filename(manifest_node[0]);
  const xml = await readManifest(manifest);
  const targets = [];
  let promise = Promise.resolve();
  const add_one = (product, shape) => {
    const qualifier = resolve_node(state, state[product]);
    if (!qualifier) return;
    promise = promise
      .then(() => resolve_literals(qualifier, manifest))
      .then(() => targets.push({ product, qualifier, shape }));
  };
  manifestProducts(xml).forEach((product) => {
    if (hasProperty(state, product) && state[product].products) {
      // this was something like round_watch. Add all the corresponding
      // products.
      state[product].products.forEach((p) => add_one(p, product));
    } else {
      add_one(product);
    }
  });
  await promise;
  await find_build_instructions(targets);
  identify_optimizer_groups(targets, options);
  return { manifest, targets, xml };
}
