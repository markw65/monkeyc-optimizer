import * as fs from "fs/promises";
import * as path from "path";
import * as jungle from "../build/jungle.js";
import { hasProperty } from "./api.js";
import { manifestProducts, readManifest } from "./manifest.js";
import { getSdkPath, globa } from "./util.js";

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
    if (dot) {
      const process_list = (values) => {
        for (let i = values.length; i--; ) {
          const v = values[i];
          if (
            v.type == "QualifiedName" &&
            v.names.every((n, i) => n === a.names[i])
          ) {
            a.values.splice(
              i,
              1,
              ...dot.map((v) =>
                v.type == "QualifiedName"
                  ? { ...v, names: v.names.concat(dotnames) }
                  : v
              )
            );
          } else if (v.type == "SubList") {
            process_list(v.values);
          }
        }
      };
      process_list(a.values);
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
  const sdk = await getSdkPath();

  if (!Array.isArray(sources)) {
    sources = [sources];
  }
  const all = [[`${sdk}bin/default.jungle`, null], ...sources];
  const results = await Promise.all(all.map(parse_one));
  const state = {};
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
          let resolved = resolve_filename(v, default_source);
          if (/[*?\[\]\{\}]/.test(resolved)) {
            // Jungle files can contain "./**.mc" which is supposed to match
            // any mc file under "./". The standard way to express that
            // is "./**/*.mc", which is what glob expects, so translate.
            resolved = resolved.replace(/\/\*\*([^/])/g, "/**/*$1");
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
    let { sourcePath, barrelPath, excludeAnnotations, annotations } =
      target.qualifier;
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
  const data = await process_jungles(jungles);
  const manifest_node = resolve_node(
    data,
    resolve_node_by_path(data, ["project", "manifest"])
  );
  if (!manifest_node) throw new Error("No manifest found!");
  const manifest = resolve_filename(manifest_node[0]);
  const xml = await readManifest(manifest);
  const targets = [];
  let promise = Promise.resolve();
  manifestProducts(xml).forEach((product) => {
    const qualifier = resolve_node(data, data[product]);
    promise = promise
      .then(() => resolve_literals(qualifier, manifest))
      .then(() => targets.push({ product, qualifier }));
  });
  await promise;
  identify_optimizer_groups(targets, options);
  return { manifest, targets };
}
