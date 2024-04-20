import * as crypto from "crypto";
import extract from "extract-zip";
import * as fs from "fs/promises";
import * as path from "path";
import * as jungle from "src/jungle.peggy";
import { hasProperty } from "./api";
import {
  manifestAnnotations,
  manifestBarrelName,
  manifestBarrels,
  manifestProducts,
  ManifestXML,
  readManifest,
} from "./manifest";
import { BuildConfig } from "./optimizer-types.js";
import {
  connectiq,
  DeviceInfo,
  getDeviceInfo,
  getLanguages,
  xmlUtil,
} from "./sdk-util";
import { globa, globSome } from "./util";

type JungleCache = {
  barrels?: Record<string, ResolvedJungle>;
  barrelMap?: Record<string, Record<string, ResolvedJungle>>;
  resources:
    | Record<
        string,
        Promise<JungleResourceMap[string]> | JungleResourceMap[string]
      >
    | JungleResourceMap;
  resolvedPaths: Record<string, Promise<boolean>>;
};

export type JungleBuildDependencies = Record<string, xmlUtil.Document | true>;
export type JungleError = Error & {
  buildDependencies?: JungleBuildDependencies;
};

type JNode = Literal | QName | Compound | SubList;

type Literal = {
  type: "Literal";
  value: string;
  source?: string;
};
type QName = {
  type: "QualifiedName";
  names: string[];
  source?: string;
};
type Compound = {
  type: "Compound";
  values: Array<Literal | QName>;
};
type SubList = {
  type: "SubList";
  values: JNode[];
  source?: string;
};

type NestedStringArray = Array<string | NestedStringArray>;
type RawJungleArrays = JNode[] | [RawJungle];
type RawJungleValue = RawJungle | RawJungleArrays | NestedStringArray;
interface RawJungle {
  [k: string]: RawJungleValue | undefined;
  "."?: RawJungleArrays;
  products?: string[];
}

function isJNode(obj: unknown): obj is JNode {
  return hasProperty(obj, "type");
}

type Assignment = { names: string[]; values: JNode[] };
async function default_jungle() {
  const assignments: Array<Assignment> = [];
  const [devices, languages] = await Promise.all([
    getDeviceInfo(),
    getLanguages(),
  ]);
  const literal = (value: string): Literal => ({ type: "Literal", value });
  const qname = (name: string): JNode => ({
    type: "QualifiedName",
    names: name.split("."),
  });
  const assign = (name: string, values: JNode[]) =>
    assignments.push({ names: name.split("."), values });
  const rassign = (name: string, values: JNode[], base: string | null) => {
    assign(name, base ? [qname(name)].concat(values) : values);
  };
  const rezAndLang = (id: string, rez: string, base: string | null = null) => {
    if (base) {
      assign(id, [qname(base)]);
    }
    rassign(`${id}.resourcePath`, [literal(rez)], base);
    rassign(
      `${id}.personality`,
      [literal(`${connectiq}/Devices/${id}`), literal(rez)],
      base
    );

    languages.forEach((l: { id: string; name: string }) =>
      rassign(`${id}.lang.${l.id}`, [literal(`${rez}-${l.id}`)], base)
    );
  };
  const done: Record<string, true> = {};

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
  const state = await process_assignments(assignments, {});
  return { state, devices };
}

function process_assignments(assignments: Assignment[], current: RawJungle) {
  return assignments.reduce((state, a) => {
    const { node, dot, dotnames } = a.names.reduce(
      (r, name) => {
        if (!hasProperty(r.node, name)) r.node[name] = {} as RawJungle;
        r.dotnames.push(name);
        r.node = r.node[name] as RawJungle;
        if (r.node["."]) {
          r.dot = r.node["."];
          r.dotnames = [];
        }
        return r;
      },
      { node: state, dot: undefined, dotnames: [] } as {
        node: RawJungle;
        dot: RawJungleArrays | undefined;
        dotnames: string[];
      }
    );
    // an assignment to a node overwrites its old value
    Object.keys(node).forEach((k) => delete node[k]);
    const process_list = (values: JNode[]) => {
      for (let i = values.length; i--; ) {
        const v = values[i];
        if (
          v.type === "QualifiedName" &&
          v.names.every((n, i) => n === a.names[i])
        ) {
          values.splice(
            i,
            1,
            ...(dot
              ? (dot as JNode[]).map((v) =>
                  v.type === "QualifiedName"
                    ? { ...v, names: v.names.concat(dotnames) }
                    : v
                )
              : [])
          );
        } else if (v.type === "SubList") {
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
        if (!current[key]) current[key] = { products: [] };
        ((current[key] as RawJungle).products as unknown as string[]).push(
          a.names[0]
        );
      }
    }
    node["."] = a.values;
    return state;
  }, current);
}

function evaluate_locals(assignments: Assignment[]) {
  const locals: Record<string, JNode[]> = {};
  let localsLength = 0;
  while (true) {
    assignments = assignments.filter((a) => {
      if (a.names.length === 1 && a.values.every((v) => v.type === "Literal")) {
        locals[a.names[0]] = a.values;
        return false;
      }
      return true;
    });
    const newLength = Object.keys(locals).length;
    if (newLength === localsLength) break;
    localsLength = newLength;
    const process_list = (values: JNode[]) => {
      for (let i = values.length; i--; ) {
        const v = values[i];
        if (v.type === "Compound") {
          process_list(v.values);
          if (v.values.every((s) => s.type === "Literal")) {
            values[i] = {
              type: "Literal",
              value: v.values
                .map((s) => (s.type === "Literal" ? s.value : ""))
                .join(""),
            };
          }
        } else if (
          v.type === "QualifiedName" &&
          v.names.length === 1 &&
          hasProperty(locals, v.names[0])
        ) {
          values.splice(i, 1, ...locals[v.names[0]]);
        } else if (v.type === "SubList") {
          process_list(v.values);
        }
      }
    };
    assignments.forEach((a) => process_list(a.values));
  }
  return assignments;
}

async function parse_one(file: string | string[]) {
  const [fileName, grammarSource] = Array.isArray(file) ? file : [file, file];
  const source = await fs.readFile(fileName).catch(() => {
    throw new Error(`Couldn't read jungle file '${fileName}`);
  });
  const assignments = jungle.parse(source.toString(), {
    grammarSource,
  }) as Assignment[];
  return evaluate_locals(assignments);
}

// Read default.jungle, and all jungles in sources, and
// return a jungle object with all local variables resolved,
// but all qualifier references left unresolved.
async function process_jungles(sources: string | (string | string[])[]) {
  if (!Array.isArray(sources)) {
    sources = [sources];
  }
  const [{ state, devices }, ...results] = await Promise.all([
    default_jungle(),
    ...sources.map(parse_one),
  ]);
  results.forEach((r) => process_assignments(r, state));
  return { state, devices };
}

function resolve_node_list(state: RawJungle, list: RawJungleValue) {
  if (!Array.isArray(list)) {
    throw new Error("Expected an array");
  }
  for (let i = list.length; i--; ) {
    const v = list[i];
    if (typeof v === "string" || Array.isArray(v)) continue;
    if (v.type === "Compound") {
      const rep = resolve_node_list(state, v.values);
      if (!Array.isArray(rep)) {
        throw new Error("Failed to resolve a compound node");
      }
      if (
        (rep as Array<JNode | string>).every(
          (v) => typeof v === "string" || v.type === "Literal"
        )
      ) {
        list[i] = {
          type: "Literal",
          value: (rep as Array<JNode | string>)
            .map((v) =>
              typeof v === "string" ? v : v.type === "Literal" ? v.value : ""
            )
            .join(""),
        };
      } else {
        v.values = rep as Array<Literal | QName>;
      }
    } else if (v.type === "QualifiedName") {
      const rep = resolve_node(state, resolve_node_by_path(state, v.names));
      if (Array.isArray(rep)) {
        if (rep.length !== 1 || (isJNode(rep[0]) && rep[0].type)) {
          resolve_node_list(state, rep);
        }
        list.splice(i, 1, ...(rep as JNode[]));
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

function check_non_leaf_dot(
  dot: RawJungleArrays,
  path: string[] | null = null,
  i = 0
) {
  if (dot.length !== 1 || dot[0].type) {
    throw new Error(
      `'.' node at ${(path || [])
        .slice(0, i + 1)
        .join(".")} should have length 1: ${JSON.stringify(dot)}`
    );
  }
}
// return the resolved node at path
function resolve_node_by_path(
  state: RawJungle,
  path: string[]
): RawJungleValue | undefined {
  return path.reduce((s: RawJungleValue | undefined, n, i) => {
    if (!s || Array.isArray(s)) {
      return s;
    }
    if (!s[n] && s["."]) {
      const sdot = s["."];
      const resolved = resolve_node_list(state, sdot);
      if (!resolved.length) return undefined;
      const r = (resolved[0] as RawJungle)[n];
      if (!r && (sdot as JNode[]).every((e) => e.type === "Literal")) {
        /*
         * We had something like:
         *
         *   foo = whatever
         *   bar = $(foo.resourcePath)
         *
         * and its supposed to work as if you'd left out the (obviously
         * incorrect) ".resourcePath"
         */
        return s;
      }
      /*
       * This is a pretty unusual edge case.
       *
       * If we do something like:
       *
       *   fenix6 = $(base)
       *   fenix5.sourcePath = $(fenix6.sourcePath)
       *
       * and fenix5 gets resolved before fenix6 (which it will,
       * currently, because products are resolved in lexicographical
       * order), we'll end up here when we try to resolve
       * fenix6.sourcePath.
       */
      check_non_leaf_dot(sdot, path, i);
      return r;
    }
    return s[n];
  }, state);
}

let depth = 0;
function resolve_node(state: RawJungle, node: RawJungleValue | undefined) {
  try {
    depth++;
    if (depth > 8) {
      console.log(depth);
    }
    return resolve_node_x(state, node);
  } finally {
    depth--;
  }
}

// fully resolve the given node, and all its children
function resolve_node_x(state: RawJungle, node: RawJungleValue | undefined) {
  if (node === undefined || Array.isArray(node)) {
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

function resolve_filename(
  literal: string | Literal,
  default_source: string | null = null
) {
  if (typeof literal === "string") return literal;
  const root = path.dirname(literal.source || default_source!);
  return path.resolve(root, literal.value);
}

async function resolve_literals(
  qualifier: RawJungle,
  default_source: string,
  deviceInfo: DeviceInfo[string],
  cache: JungleCache
): Promise<JungleQualifier> {
  const resolve_file_list = (
    literals: JNode[] | NestedStringArray
  ): Promise<NestedStringArray> =>
    Promise.all(
      literals.map((v) => {
        if (!isJNode(v)) {
          return v;
        }
        if (v.type === "QualifiedName") {
          throw new Error("Unexpected QualifiedName found!");
        }
        if (v.type === "SubList") {
          return resolve_file_list(v.values);
        }
        if (v.type === "Compound") {
          throw new Error("Oops");
        }
        // Jungle files can contain "./**.mc" which is supposed to match
        // any mc file under "./". The standard way to express that
        // is "./**/*.mc", which is what glob expects, so translate.
        const resolved = resolve_filename(v, default_source).replace(
          /[\\/]\*\*([^\\/])/g,
          "/**/*$1"
        );
        if (!hasProperty(cache.resolvedPaths, resolved)) {
          if (/[*?[\]{}]/.test(resolved)) {
            cache.resolvedPaths[resolved] = globSome(resolved, () => true);
          } else {
            cache.resolvedPaths[resolved] = fs.stat(resolved).then(
              () => true,
              () => false
            );
          }
        }
        return cache.resolvedPaths[resolved].then((exists) =>
          exists ? resolved : null
        );
      })
    ).then((results) =>
      results.filter((name): name is NonNullable<typeof name> => name != null)
    );

  const resolve_one_file_list = async (base: RawJungle, name: string) => {
    const bname = base[name];
    if (!bname) return;
    const result = await resolve_file_list(
      bname as JNode[] | NestedStringArray
    );
    if (!result || !result.length) {
      delete base[name];
    } else {
      base[name] = result;
    }
  };

  const promises = [
    resolve_one_file_list(qualifier, "sourcePath"),
    resolve_one_file_list(qualifier, "resourcePath"),
    resolve_one_file_list(qualifier, "personality"),
    resolve_one_file_list(qualifier, "barrelPath"),
  ];
  const lang = qualifier["lang"] as RawJungle;
  if (lang) {
    Object.keys(lang).forEach((key) => {
      promises.push(resolve_one_file_list(lang, key));
    });
  }
  await Promise.all(promises).then(() => {
    if (!lang || Object.keys(lang).length === 0) {
      delete qualifier["lang"];
    }
  });

  const resolve_literal_list = (base: RawJungle, name: string) => {
    const literals = base[name] as Literal[];
    if (!literals || !literals.length) return;
    base[name] = literals.map((v) => v.value);
  };
  resolve_literal_list(qualifier, "excludeAnnotations");
  // turn the annotations inside out.
  // in the jungle we have
  //   qualifier.BarrelName.annotations = Foo;Bar
  // but its more convenient as
  //   qualifier.annotations.BarrelName = Foo;Bar
  const annotations: BarrelAnnotations = {};
  Object.entries(qualifier).forEach(([k, v]) => {
    if (hasProperty(v, "annotations")) {
      annotations[k] = (v as BarrelAnnotations)["annotations"];
      resolve_literal_list(annotations, k);
      delete qualifier[k as keyof JungleQualifier];
    }
  });
  qualifier.annotations = annotations;
  return qualifier as JungleQualifier;
}

type ResourceGroups = Record<
  string,
  {
    resourcePath: string[];
    resourceFiles: { path: string; resources: xmlUtil.Document }[];
    resourceMap: JungleResourceMap;
    products: string[];
    buildInstructions?: {
      sourceExcludes: string[];
      excludeAnnotations: string[];
    };
  }
>;

async function read_resource_files(targets: Target[], cache: JungleCache) {
  const resourceGroups: ResourceGroups = {};
  const resourceGroupPromises: Record<
    string,
    Promise<ResourceGroups[string]> //| ResourceGroups[string]
  > = {};
  const resources: JungleResourceMap = {};
  if (!cache.resources) {
    cache.resources = {};
  }
  await Promise.all(
    targets.map((p) => {
      if (!p.qualifier.resourcePath) return null;
      const key = p.qualifier.resourcePath.join(";");
      if (!hasProperty(resourceGroupPromises, key)) {
        resourceGroupPromises[key] = Promise.all(
          p.qualifier.resourcePath.map((pattern) =>
            globa(pattern, { mark: true })
          )
        )
          .then((patterns) =>
            Promise.all(
              patterns
                .flat()
                .map((path) =>
                  path.endsWith("/")
                    ? globa(`${path}**/*.xml`, { mark: true })
                    : path
                )
            )
          )
          .then((paths) =>
            Promise.all(
              paths
                .flat()
                .filter((file) => file.endsWith(".xml"))
                .map((file) => {
                  if (!hasProperty(cache.resources, file)) {
                    cache.resources[file] = fs
                      .readFile(file)
                      .then((data) => xmlUtil.parseXml(data.toString(), file));
                  }
                  return Promise.resolve(cache.resources[file]).then((rez) => {
                    cache.resources[file] = resources[file] = rez;
                    return {
                      path: file,
                      resources: rez,
                    };
                  });
                })
            )
          )
          .then(
            (resourceFiles) =>
              (resourceGroups[key] = {
                resourcePath: p.qualifier.resourcePath!,
                resourceFiles,
                resourceMap: Object.fromEntries(
                  resourceFiles.map((e) => [e.path, e.resources])
                ),
                products: [],
              })
          );
      }
      if (p.qualifier.barrelMap) {
        Object.values(p.qualifier.barrelMap).forEach((e) =>
          Object.assign(resources, e.resources)
        );
      }
      resourceGroupPromises[key] = resourceGroupPromises[key].then((rg) => {
        rg.products.push(p.product);
        p.qualifier.resourceMap = rg.resourceMap;
        return rg;
      });
      return resourceGroupPromises[key];
    })
  );
  return { resources, resourceGroups };
}

async function find_build_instructions_in_resource(
  file: string,
  rez: xmlUtil.Document,
  buildDependencies: JungleBuildDependencies
) {
  if (rez.body instanceof Error) {
    buildDependencies[file] = true;
    return null;
  }
  const build = rez.body.skip("resources").filter("build");
  if (!build.length()) return null;
  buildDependencies[file] = true;
  const excludes = build.children("exclude").attrs();
  if (!excludes.length) return null;
  const dir = path.dirname(file);
  const sourceExcludes = excludes
    .map((e) => e.file?.value.value)
    .filter((f: string | undefined): f is string => f != null)
    .map((f: string) => path.resolve(dir, f).replace(/\\/g, "/"));

  const filePatterns: string[] = excludes
    .map((e) => e.dir?.value.value)
    .filter((f: string | undefined): f is string => f != null)
    .map((f: string) => path.join(dir, f, "**", "*.mc").replace(/\\/g, "/"));
  if (filePatterns.length) {
    const files = (await Promise.all(filePatterns.map((p) => globa(p)))).flat();
    sourceExcludes.push(...files);
  }
  const excludeAnnotations = excludes
    .map((e) => e.annotation?.value.value)
    .filter((f: string | undefined): f is string => f != null);
  return { sourceExcludes, excludeAnnotations };
}

async function find_build_instructions(
  targets: Target[],
  resourceGroups: ResourceGroups,
  buildDependencies: JungleBuildDependencies
) {
  await Promise.all(
    targets.map(async (p) => {
      if (!p.qualifier.resourcePath) return;
      const key = p.qualifier.resourcePath.join(";");
      if (!hasProperty(resourceGroups, key)) return;
      if (!hasProperty(resourceGroups[key], "buildInstructions")) {
        resourceGroups[key].buildInstructions = (
          await Promise.all(
            resourceGroups[key].resourceFiles.map(({ path, resources }) =>
              find_build_instructions_in_resource(
                path,
                resources,
                buildDependencies
              )
            )
          )
        )
          .filter((i): i is NonNullable<typeof i> => i != null)
          // Each element of the array is the set of build instructions
          // from a particular resource file. The order is the order of the
          // resource paths in the .jungle file. The docs say we should
          // only take the "most specific" build instructions, without
          // making it clear what that means if you've added your own
          // resource paths, but I'm going with "the last one" (which will
          // work for all the default paths), so split that off.
          .pop();
      }
      const buildInstructions = resourceGroups[key].buildInstructions;

      if (buildInstructions) {
        if (
          buildInstructions.sourceExcludes &&
          buildInstructions.sourceExcludes.length
        ) {
          p.qualifier.sourceExcludes = buildInstructions.sourceExcludes;
        }
        if (
          buildInstructions.excludeAnnotations &&
          buildInstructions.excludeAnnotations.length
        ) {
          if (p.qualifier.excludeAnnotations) {
            p.qualifier.excludeAnnotations.push(
              ...buildInstructions.excludeAnnotations
            );
          } else {
            p.qualifier.excludeAnnotations =
              buildInstructions.excludeAnnotations;
          }
        }
      }
    })
  );
}

function identify_optimizer_groups(targets: Target[], options: BuildConfig) {
  const groups: Record<
    string,
    { key: string; optimizerConfig: JungleQualifier }
  > = {};
  let key = 0;
  const ignoreStrOption = (
    str: string | null | undefined
  ): Record<string, true> | string | null =>
    str == null
      ? null
      : str === "*"
      ? "*"
      : Object.fromEntries(str.split(";").map((e) => [e, true]));
  const getStrsWithIgnore = (
    strs: string[],
    option: Record<string, true> | string | null
  ) => {
    if (option === "*") {
      return [];
    } else {
      return strs.filter((a) => !hasProperty(option, a));
    }
  };
  const ignoreRegExpOption = (
    str: string | null | undefined
  ): RegExp | null => {
    try {
      if (!str) return null;
      return new RegExp(str);
    } catch {
      return null;
    }
  };

  if (options.extraExcludes) {
    const toAdd: string[] = [];
    const toRemove: string[] = [];
    options.extraExcludes.split(";").forEach((exclude) => {
      if (exclude.startsWith("-")) {
        toRemove.push(exclude.slice(1));
      } else {
        toAdd.push(exclude);
      }
    });
    targets.forEach((target) => {
      const ex = Object.fromEntries(
        (target.qualifier.excludeAnnotations?.concat(toAdd) ?? toAdd).map(
          (x) => [x, true] as const
        )
      );
      toRemove.forEach((r) => delete ex[r]);
      target.qualifier.excludeAnnotations = Object.keys(ex);
    });
  }
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
        { keys: {}, paths: {} } as {
          keys: Record<string, Record<string, true>>;
          paths: Record<string, Record<string, true>>;
        }
      ).paths
    : null;

  targets.forEach((target) => {
    let {
      sourcePath,
      sourceExcludes,
      barrelPath,
      barrelMap,
      excludeAnnotations,
      annotations,
      resourceMap,
      resourcePath,
      personality,
    } = target.qualifier;
    if (excludeAnnotations && ignoredExcludeAnnotations) {
      excludeAnnotations = getStrsWithIgnore(
        excludeAnnotations,
        ignoredExcludeAnnotations
      );
    }
    annotations &&
      Object.entries(annotations).forEach(([key, value]) => {
        if (ignoredAnnotations) {
          annotations![key] = getStrsWithIgnore(value, ignoredAnnotations);
        }
      });
    if (ignoredSourcePaths) {
      sourcePath = sourcePath
        ?.map((path) => Object.keys(ignoredSourcePaths[path]))
        .flat()
        .sort()
        .filter((v, i, a) => i === 0 || v !== a[i - 1]);
    }
    const optimizerConfig = {
      sourcePath,
      sourceExcludes,
      barrelPath,
      barrelMap,
      excludeAnnotations,
      annotations,
      resourceMap,
      personality,
    };

    const toSortedEntries = <T>(value: Record<string, T>) =>
      Object.entries(value)
        .filter(([, v]) => v != null)
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] === b[0] ? 0 : 1));

    const serialized = JSON.stringify(optimizerConfig, function (key, value) {
      if (!value || Array.isArray(value) || typeof value !== "object") {
        return value;
      }
      if (key === "") {
        if (barrelMap) {
          const bm = toSortedEntries(barrelMap).map(([k, v]) => {
            const { jungles, qualifier } = v;
            return [k, [jungles, qualifier]];
          });
          value = { ...value, barrelMap: bm };
        }
        if (resourceMap) {
          value = { ...value, resourceMap: resourcePath };
        }
      }
      return toSortedEntries(value);
    });
    if (!hasProperty(groups, serialized)) {
      groups[serialized] = {
        key: "group" + key.toString().padStart(3, "0"),
        optimizerConfig,
      };
      key++;
    }
    target.group = groups[serialized];
    if (!target.group.optimizerConfig.products) {
      target.group.optimizerConfig.products = [];
    }
    target.group.optimizerConfig.products.push(target.product);
  });
}

/**
 * Find the barrels referred to by barrelPath.
 *
 * Each string in barrelPath is a glob that can expand to a
 * .jungle file, a .barrel file, or a directory. If it
 * expands to a directory, that directory is searched recursively
 * for .barrel files.
 *
 * @param {string|string[]} barrelPath the path or paths to search
 * @returns {Promise<string[]>}
 */
function find_barrels(barrelPath: string | string[]) {
  if (Array.isArray(barrelPath)) {
    // This is a sublist. The barrel has more than one jungle file.
    return Promise.all(
      barrelPath.map((path) => globa(path, { mark: true }))
    ).then((paths) => [
      paths
        .flat()
        .filter((path) => path.endsWith(".jungle"))
        .join(";"),
    ]);
  }
  return globa(barrelPath, { mark: true })
    .then((paths) =>
      Promise.all(
        paths.map((path) =>
          path.endsWith("/") ? globa(`${path}**/*.barrel`) : path
        )
      )
    )
    .then((barrelPaths) =>
      barrelPaths
        .flat()
        .filter((path) => path.endsWith(".jungle") || path.endsWith(".barrel"))
    );
}

export type Target = {
  product: string;
  qualifier: JungleQualifier;
  shape?: string;
  group?: { optimizerConfig: JungleQualifier; dir?: string; key: string };
};

type LangResourcePaths = { [key: string]: string[] }; // Map from language codes to the corresponding resource paths
type BarrelAnnotations = { [key: string]: string[] }; // Map from barrel name to imported annotations
type BarrelMap = { [key: string]: ResolvedBarrel }; // Map from barrel name to the resolved barrel project for that name.
type OptBarrelMap = Record<
  string,
  {
    rawBarrelDir: string;
    manifest: string;
    jungleFiles: string[];
    optBarrelDir: string;
  }
>;

export type JungleQualifier = {
  sourcePath?: string[]; // locations to find source file
  sourceExcludes?: string[]; // array of files to exclude from the build (from resource build instructions)
  excludeAnnotations?: string[]; // array of excludeAnnotations
  resourcePath?: string[]; // locations to find resource files
  personality?: string[]; // locations to find personality (.mss) files
  lang?: LangResourcePaths; // locations to find resource files
  barrelPath?: (string | string[])[]; // locations to find barrels
  annotations?: BarrelAnnotations; // map from barrel names to arrays of annotations
  barrelMap?: BarrelMap;
  optBarrels?: OptBarrelMap;
  resourceMap?: JungleResourceMap;
  products?: string[];
};

// The result of parsing a jungle file, without resolving any products
type JungleInfoBase = {
  jungles: string[]; // Paths to the project's jungle files
  manifest: string; // Path to the project's manifest file
  xml: ManifestXML; // The xml content of the manifest
  annotations?: string[]; // Array of annotations supported by this barrel
  resources: JungleResourceMap;
  buildDependencies: JungleBuildDependencies;
  devices: DeviceInfo;
};

export type JungleResourceMap = Record<string, xmlUtil.Document>;

// The result of parsing an application's jungle file
export type ResolvedJungle = JungleInfoBase & {
  targets: Target[];
  typeCheckLevel?: string;
  optimizationLevel?: string;
};

// The result of parsing a barrel's jungle file for a particular product
export type ResolvedBarrel = JungleInfoBase & {
  qualifier: JungleQualifier; // The qualifier for this barrel's target
};

/**
 * Given a .barrel file, unpack it into barrelDir, then process its .jungle file as below
 * Given a .jungle file, resolve it to a ResolvedJungle
 *
 * @param {string} barrel Path to a .jungle or .barrel file to resolve
 * @param {string} barrelDir Directory where .barrel files should be unpacked
 * @param {string[]} products The products supported by the importing project
 * @param {BuildConfig} options
 * @returns {Promise<ResolvedJungle>}
 */
function resolve_barrel(
  barrel: string,
  barrelDir: string,
  products: string[],
  options: BuildConfig,
  cache: JungleCache,
  buildDependencies: JungleBuildDependencies
): ResolvedJungle | Promise<ResolvedJungle> {
  if (hasProperty(cache.barrels, barrel)) {
    return cache.barrels[barrel];
  }
  let promise = Promise.resolve();
  let rawBarrel = barrel;
  if (barrel.endsWith(".barrel")) {
    // A barrel with the given name could in theory resolve to a different physical
    // barrel file for each product, so uniqify the local name with a sha1.
    const sha1 = crypto
      .createHash("sha1")
      .update(barrel, "binary")
      .digest("base64")
      .replace(/[/=+]/g, "");
    const localPath = path.resolve(
      barrelDir,
      `${path.basename(barrel, ".barrel")}-${sha1}`
    );
    rawBarrel = path.resolve(localPath, "barrel.jungle");
    promise = promise.then(() =>
      fs
        .stat(localPath)
        .then(
          (localStat) =>
            !localStat.isDirectory() ||
            fs
              .stat(barrel)
              .then((barrelStat) => localStat.mtimeMs < barrelStat.mtimeMs),
          () => true
        )
        .then((needsUpdate) => {
          needsUpdate &&
            fs
              .rm(localPath, { recursive: true, force: true })
              .then(() => extract(barrel, { dir: localPath }));
        })
    );
  }
  return promise
    .then(() => get_jungle_and_barrels(rawBarrel, products, options, cache))
    .then((result) => {
      Object.values(result.resources).forEach(
        (rez) => rez.data || (rez.data = { barrel })
      );
      Object.entries(result.buildDependencies).forEach(
        ([k, v]) => (buildDependencies[k] = v)
      );
      if (!cache.barrels) cache.barrels = {};
      return (cache.barrels[barrel] = { ...result });
    })
    .catch((e) => {
      if (e instanceof Error) {
        const err: JungleError = e;
        if (err.buildDependencies) {
          Object.entries(err.buildDependencies).forEach(
            ([k, v]) => (buildDependencies[k] = v)
          );
        }
      }
      throw e;
    });
}

/**
 * Find and resolve the BarrelMap for product, and add it to qualifier.
 *
 * @param {string} product The device id we're resolving
 * @param {JungleQualifier} qualifier The qualifier for product from the main jungle
 * @param {string[]} barrels The barrels imported by the project's manifest
 * @param {string[]} products The products supported by the importing project (used when the barrel project has none)
 * @param {BuildConfig} options
 * @returns {Promise<void>}
 */
function resolve_barrels(
  product: string,
  qualifier: JungleQualifier,
  barrels: string[],
  products: string[],
  options: BuildConfig,
  cache: JungleCache,
  buildDependencies: JungleBuildDependencies
) {
  if (qualifier.annotations) {
    Object.keys(qualifier.annotations).forEach((key) => {
      // delete annotations for non-existent barrels such as
      if (!barrels.includes(key)) {
        delete qualifier.annotations![key];
      }
    });
  }
  if (!barrels.length) {
    delete qualifier.barrelPath;
    return null;
  }
  const barrelMapKey = JSON.stringify([barrels, qualifier.barrelPath]);
  const setBarrelMap = (barrelMap: Record<string, ResolvedJungle>) => {
    qualifier.barrelMap = barrels.reduce((result, barrel) => {
      const { targets, ...rest } = barrelMap[barrel];
      const target = targets.find((t) => t.product === product);
      if (!target) {
        throw new Error(`Barrel ${barrel} does not support device ${product}`);
      }
      const resolvedBarrel = { qualifier: target.qualifier, ...rest };
      result[barrel] = resolvedBarrel;
      return result;
    }, {} as BarrelMap);
  };
  if (hasProperty(cache.barrelMap, barrelMapKey)) {
    setBarrelMap(cache.barrelMap[barrelMapKey]);
    return null;
  }
  const barrelDir = path.resolve(
    options.workspace!,
    options.outputPath!,
    "raw-barrels"
  );
  const barrelMap: Record<string, ResolvedJungle | null> = Object.fromEntries(
    barrels.map((b) => [b, null])
  );
  return (qualifier.barrelPath || [])
    .reduce(
      (promise, barrelPath) =>
        promise
          .then(() => find_barrels(barrelPath))
          .then((barrelPaths) => {
            return Promise.all(
              barrelPaths.map((barrel) =>
                resolve_barrel(
                  barrel,
                  barrelDir,
                  products,
                  options,
                  cache,
                  buildDependencies
                )
              )
            );
          })
          .then((resolvedBarrels) => {
            resolvedBarrels.forEach((resolvedBarrel) => {
              const name = manifestBarrelName(
                resolvedBarrel.manifest,
                resolvedBarrel.xml
              );
              if (!hasProperty(barrelMap, name)) return;
              const bmapName = barrelMap[name];
              if (bmapName) {
                const bname = (r: ResolvedJungle) => r.jungles.join(";");
                throw new Error(
                  `Barrel ${name} already resolved to ${bname(
                    bmapName
                  )}; can't also resolve to ${bname(resolvedBarrel)}`
                );
              }
              barrelMap[name] = resolvedBarrel;
            });
          }),
      Promise.resolve()
    )
    .then(() => {
      const unresolved = Object.entries(barrelMap).filter((v) => v[1] === null);
      if (unresolved.length) {
        throw new Error(
          `Failed to resolve some barrels: ${unresolved
            .map(([name]) => name)
            .join(",")}`
        );
      }
      const finalMap = barrelMap as Record<string, ResolvedJungle>;
      if (!cache.barrelMap) cache.barrelMap = {};
      cache.barrelMap[barrelMapKey] = finalMap;
      setBarrelMap(finalMap);
    });
}
/**
 *
 * @param {string} jungleFiles Semicolon separated list of jungle files
 * @param {string[]} defaultProducts Default set of products. Only used by a barrel with no products of its own
 * @param {BuildConfig} options
 * @returns {Promise<ResolvedJungle>}
 */
async function get_jungle_and_barrels(
  jungleFiles: string,
  defaultProducts: string[] | null,
  options: BuildConfig,
  cache: JungleCache
): Promise<ResolvedJungle> {
  const buildDependencies: JungleBuildDependencies = {};
  try {
    const jungles = jungleFiles
      .split(";")
      .map((jungle) => path.resolve(options.workspace || "./", jungle));
    const barrels_jungle = path.resolve(
      path.dirname(jungles[0]),
      "barrels.jungle"
    );
    if (!jungles.includes(barrels_jungle)) {
      if (
        await fs
          .stat(barrels_jungle)
          .then((s) => s.isFile())
          .catch(() => false)
      ) {
        jungles.push(barrels_jungle);
      }
    }
    jungles.forEach((j) => (buildDependencies[j] = true));
    const { state, devices } = await process_jungles(jungles);
    // apparently square_watch is an alias for rectangle_watch
    state["square_watch"] = state["rectangle_watch"];
    const manifest_node = resolve_node(
      state,
      resolve_node_by_path(state, ["project", "manifest"])
    ) as string[] | null;
    if (!manifest_node) throw new Error("No manifest found!");
    const manifest = resolve_filename(manifest_node[0]);
    buildDependencies[manifest] = true;
    if (!options.workspace) {
      options.workspace = path.dirname(manifest);
    }
    if (!hasProperty(cache.resources, manifest)) {
      cache.resources[manifest] = readManifest(manifest);
    }
    const xml = await Promise.resolve(cache.resources[manifest]);
    if (xml.body instanceof Error) {
      throw xml;
    }
    buildDependencies[manifest] = xml;
    const targets: Target[] = [];
    const barrels = manifestBarrels(xml);
    const annotations = manifestAnnotations(xml);
    const products = manifestProducts(xml);
    if (products.length === 0) {
      if (defaultProducts) {
        products.push(...defaultProducts);
      } else if (xml.body.children("iq:barrel").length()) {
        products.push(...Object.keys(devices).sort());
      }
    }
    let promise = Promise.resolve();
    const add_one = (
      product: string,
      shape: string | undefined = undefined
    ) => {
      const rawQualifier = resolve_node(state, state[product]);
      if (!rawQualifier || Array.isArray(rawQualifier)) return;
      promise = promise
        .then(() =>
          resolve_literals(rawQualifier, manifest, devices[product], cache)
        )
        .then((qualifier) => {
          targets.push({ product, qualifier, shape });
          return resolve_barrels(
            product,
            qualifier,
            barrels,
            products,
            options,
            cache,
            buildDependencies
          );
        })
        .then(() => {
          return;
        });
    };
    products.forEach((product) => {
      if (hasProperty(state, product)) {
        const sp = state[product];
        if (sp && !Array.isArray(sp) && sp.products) {
          // this was something like round_watch. Add all the corresponding
          // products.
          sp.products.forEach((p: string) => add_one(p, product));
        } else {
          add_one(product);
        }
      }
    });
    await promise;
    const { resourceGroups, resources } = await read_resource_files(
      targets,
      cache
    );
    await find_build_instructions(targets, resourceGroups, buildDependencies);
    const typeCheckNode = resolve_node(
      state,
      resolve_node_by_path(state, ["project", "typecheck"])
    ) as Literal[] | null;
    const optimizationNode = resolve_node(
      state,
      resolve_node_by_path(state, ["project", "optimization"])
    ) as Literal[] | null;
    const typeCheckLevel = typeCheckNode?.[0]?.value;
    const optimizationLevel = optimizationNode?.[0]?.value;

    const result: ResolvedJungle = {
      manifest,
      targets,
      xml,
      annotations,
      jungles,
      resources,
      buildDependencies,
      devices,
    };
    if (typeCheckLevel != null) {
      result.typeCheckLevel = typeCheckLevel;
    }
    if (optimizationLevel != null) {
      result.optimizationLevel = optimizationLevel;
    }
    return result;
  } catch (e) {
    const err: JungleError =
      e instanceof Error ? e : new Error("An unknown error occurred");
    err.buildDependencies = buildDependencies;
    throw err;
  }
}

export async function get_jungle(
  jungles: string,
  options: BuildConfig,
  resources?: JungleResourceMap | undefined
): Promise<ResolvedJungle> {
  options = options || {};
  const cache: JungleCache = {
    resources: { ...(resources || {}) },
    resolvedPaths: {},
  };
  const result = await get_jungle_and_barrels(jungles, null, options, cache);
  identify_optimizer_groups(result.targets, options);
  return result;
}
