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

// return the resolved node at path
function resolve_node_by_path(state, path) {
  return path.reduce((s, n, i) => {
    const sn = s[n];
    if (!i) {
      // resolving the base node resolves all its children,
      // so only need to resolve once.
      return (s[n] = resolve_node(state, s[n]));
    }
    return sn;
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
    for (let i = dot.length; i--; ) {
      const v = dot[i];
      if (v.type == "QualifiedName") {
        dot.splice(i, 1);
        let resolved = resolve_node_by_path(state, v.names);
        if (Array.isArray(resolved)) {
          dot.splice(i, 0, ...resolved);
        } else if (resolved) {
          dot.splice(i, 0, resolved);
        }
      }
    }
    delete node["."];
  }
  const entries = Object.entries(rest);
  if (dot) {
    if (dot.length == 1 && !dot[0]["type"]) {
      Object.assign(node, dot[0]);
    } else {
      return dot;
    }
  }

  entries.forEach(([key, value]) => {
    node[key] = resolve_node(state, value);
  });
  return node;
}

function resolve_filename(literal, default_source) {
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
  await Promise.all(
    Object.keys(lang).map((key) => resolve_one_file_list(lang, key))
  );
  if (Object.keys(lang).length === 0) delete qualifier["lang"];

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
  targets.forEach((target) => {
    let { sourcePath, barrelPath, excludeAnnotations, annotations } =
      target.qualifier;
    if (excludeAnnotations && options.ignoredExcludeAnnotations) {
      excludeAnnotations = excludeAnnotations.filter(
        (a) => !options.ignoredExcludeAnnotations.includes(a)
      );
    }
    if (annotations && options.ignoredAnnotations) {
      annotations = annotations.filter(
        (a) => !options.ignoredAnnotations.includes(a)
      );
    }
    const optimizerConfig = {
      sourcePath,
      barrelPath,
      excludeAnnotations,
      annotations,
    };

    const serialized = JSON.stringify(optimizerConfig);
    if (!hasProperty(groups, serialized)) {
      groups[serialized] = {
        key,
        optimizerConfig,
      };
      key++;
    }
    target.group = groups[serialized];
  });
}

export async function get_jungle(jungles, options) {
  options = options || {};
  // jungles = "/Users/mwilliams/www/git/garmin-samples/Picker/monkey.jungle"
  const data = await process_jungles(jungles.split(";"));
  const manifest_node = resolve_node_by_path(data, ["project", "manifest"]);
  if (!manifest_node) throw "No manifest found!";
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
  return targets;
}

get_jungle(
  "/Users/mwilliams/www/git/HRMultifield/monkey.jungle;/Users/mwilliams/www/git/HRMultifield/generated/device-specific.jungle",
  {
    ignoredExcludeAnnotations: [
      "high_memory",
      "json_data",
      "string_data",
      "require_settings_view",
    ],
  }
).then((targets) => console.log(JSON.stringify(targets)));
