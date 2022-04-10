import * as fs from "fs/promises";
import * as jungle from "../build/jungle.js";
import { getSdkPath } from "./util.js";
import { hasProperty } from "./api.js";

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

async function process_jungles(sources) {
  const sdk = await getSdkPath();

  if (!Array.isArray(sources)) {
    sources = [sources];
  }
  const all = [[`${sdk}bin/default.jungle`, "default"], ...sources];
  const results = await Promise.all(all.map(parse_one));
  const state = {};
  results.forEach((r) => process_assignments(r, state));
  return state;
}

// return the resolved node at path
function resolve_path(state, path) {
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
  if (Array.isArray(node)) {
    // an already optimized leaf node
    return node;
  }
  const { ".": dot, ...rest } = node;
  if (dot) {
    for (let i = dot.length; i--; ) {
      const v = dot[i];
      if (v.type == "QualifiedName") {
        dot.splice(i, 1);
        let resolved = resolve_path(state, v.names);
        if (Array.isArray(resolved)) {
          dot.splice(i, 0, ...resolved);
        } else {
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

process_jungles(
  "/Users/mwilliams/www/git/garmin-samples/Picker/monkey.jungle"
).then((data) => {
  console.log(JSON.stringify(resolve_path(data, ["project", "manifest"])));
  // console.log(JSON.stringify(data));
  console.log(JSON.stringify(resolve_path(data, ["fenix5"])));
});
