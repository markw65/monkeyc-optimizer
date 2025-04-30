import * as path from "path";
import { hasProperty, resolveDiagnosticsMap } from "./api";
import { JungleQualifier, JungleResourceMap, Target } from "./jungles";
import { analyze, getFileASTs, reportMissingSymbols } from "./mc-rewrite";
import {
  BuildConfig,
  Diagnostic,
  ExcludeAnnotationsMap,
  FilesToOptimizeMap,
  ProgramStateAnalysis,
} from "./optimizer-types";
import { pragmaChecker } from "./pragma-checker";
import { xmlUtil } from "./sdk-util";
import { TypeMap } from "./type-flow/interp";
import { analyze_module_types } from "./type-flow/module-types";
import { globa } from "./util";
import { manifestProducts } from "./manifest";

export type PreAnalysis = {
  fnMap: FilesToOptimizeMap;
  paths: string[];
};

export type Analysis = {
  fnMap: FilesToOptimizeMap;
  paths: string[];
  state: ProgramStateAnalysis;
  typeMap?: TypeMap | null | undefined;
};

export function relative_path_no_dotdot(relative: string) {
  return relative.replace(
    /^(\.\.[\\/])+/,
    (str) => `__${"dot".repeat(str.length / 3)}__${str.slice(-1)}`
  );
}

async function filesFromPaths(
  workspace: string,
  buildDir: string,
  inPaths: string[] | null | undefined,
  extension: string
) {
  const filter = buildDir.startsWith(workspace);
  const paths = (
    await Promise.all(
      inPaths?.map((pattern) =>
        globa(pattern, { cwd: workspace, mark: true }).then((paths) =>
          paths.map((p) => ({
            path: p,
            filter:
              filter &&
              /^\*\*[\\/]\*\.mc$/i.test(path.relative(workspace, pattern)),
          }))
        )
      ) || []
    )
  ).flat();

  const files = await Promise.all(
    paths.map((result) =>
      result.path.endsWith("/")
        ? globa(`${result.path}**/*${extension}`, {
            cwd: workspace,
            mark: true,
          }).then((paths) =>
            paths.map((path) => ({
              path,
              filter: result.filter,
            }))
          )
        : result
    )
  );
  const buildDirNormalized = buildDir.replace(/\\/g, "/");
  return {
    files: files
      .flat()
      .filter(
        (file) =>
          file.path.endsWith(extension) &&
          (!file.filter || !file.path.startsWith(buildDirNormalized))
      )
      .map(({ path }) => path),
    paths: paths
      .filter(({ path }) => path.endsWith("/"))
      .map(({ path }) => path),
  };
}

export async function fileInfoFromConfig(
  workspace: string,
  buildDir: string,
  output: string,
  buildConfig: JungleQualifier,
  extraExcludes: ExcludeAnnotationsMap,
  barrel: string
): Promise<PreAnalysis> {
  const { files, paths } = await filesFromPaths(
    workspace,
    buildDir,
    buildConfig.sourcePath,
    ".mc"
  );

  const { files: personalityFiles } = await filesFromPaths(
    workspace,
    buildDir,
    buildConfig.personality,
    ".mss"
  );

  const excludeAnnotations = Object.assign(
    buildConfig.excludeAnnotations
      ? Object.fromEntries(
          buildConfig.excludeAnnotations.map((ex) => [ex, true])
        )
      : {},
    extraExcludes
  );

  return {
    fnMap: Object.fromEntries(
      files
        .filter(
          (file) =>
            !buildConfig.sourceExcludes ||
            !buildConfig.sourceExcludes.includes(file)
        )
        .concat(personalityFiles)
        .map((file) => [
          file,
          {
            name: file,
            output: path.join(
              output,
              relative_path_no_dotdot(path.relative(workspace, file))
            ),
            barrel,
            excludeAnnotations,
          },
        ])
    ),
    paths: paths.filter((path) => path.endsWith("/")),
  };
}

export async function getProjectAnalysisHelper(
  targets: Target[],
  analysis: PreAnalysis | null,
  manifestXML: xmlUtil.Document,
  options: BuildConfig
): Promise<Analysis | PreAnalysis> {
  const qualifiers: Map<
    string,
    { sourcePath: Set<string>; personality: Set<string>; root: string }
  > = new Map();

  const addQualifier = (
    name: string,
    qualifier: JungleQualifier,
    root: string
  ) => {
    const sp = qualifier.sourcePath;
    const pp = qualifier.personality;
    if (sp || pp) {
      let q = qualifiers.get(name);
      if (!q) {
        q = {
          sourcePath: new Set(),
          personality: new Set(),
          root,
        };
        qualifiers.set(name, q);
      }
      sp?.forEach((s) => q!.sourcePath!.add(s));
      pp?.forEach((p) => q!.personality!.add(p));
    }
  };

  const products = targets.map(({ qualifier, product }) => {
    addQualifier("", qualifier, options.workspace!);
    if (qualifier.barrelMap) {
      Object.entries(qualifier.barrelMap).forEach(([name, bm]) => {
        addQualifier(name, bm.qualifier, path.dirname(bm.jungles[0]));
      });
    }
    return product;
  });

  const { workspace, outputPath } = options;
  const { fnMap, paths } = await Promise.all(
    Array.from(qualifiers).map(([name, qualifier]) =>
      fileInfoFromConfig(
        qualifier.root,
        path.resolve(workspace!, outputPath ?? "bin/optimized"),
        workspace!,
        {
          sourcePath: Array.from(qualifier.sourcePath),
          personality: Array.from(qualifier.personality),
          products: name === "" ? products : undefined,
        },
        {},
        name
      )
    )
  )
    .then(
      (results) =>
        results.reduce((cur, result) => {
          if (!cur) return result;
          Object.entries(result.fnMap).forEach(([key, value]) => {
            if (cur.fnMap[key]) {
              cur.fnMap[key + "::" + value.barrel] = value;
            } else {
              cur.fnMap[key] = value;
            }
          });
          cur.paths.push(...result.paths);
          return cur;
        }, null as PreAnalysis | null)!
    )
    .then(
      (result) =>
        result ??
        Promise.reject(
          new Error(
            `No valid devices found in manifest. Found ${
              manifestProducts(manifestXML)
                .map((p) => `'${p}'`)
                .join(", ") || "no products"
            }`
          )
        )
    );

  if (analysis) {
    Object.entries(fnMap).forEach(([k, v]) => {
      if (hasProperty(analysis.fnMap, k)) {
        const old = analysis.fnMap[k];
        if (old.monkeyCSource) v.monkeyCSource = old.monkeyCSource;
        if (old.ast) v.ast = old.ast;
      }
    });
  }

  await getFileASTs(fnMap);

  const resourcesMap: Record<string, JungleResourceMap> = {};
  const addResources = (
    name: string,
    resources: JungleResourceMap | null | undefined
  ) => {
    if (!resources) return;
    if (!hasProperty(resourcesMap, name)) {
      resourcesMap[name] = { ...resources };
    } else {
      Object.assign(resourcesMap[name], resources);
    }
  };
  targets.forEach((target) => {
    addResources("", target.qualifier.resourceMap);
    if (target.qualifier.barrelMap) {
      Object.entries(target.qualifier.barrelMap).forEach(([key, value]) =>
        addResources(key, value.resources)
      );
    }
  });
  return {
    ...(await getFnMapAnalysis(fnMap, resourcesMap, manifestXML, options)),
    paths,
  };
}

export async function getFnMapAnalysis(
  fnMap: FilesToOptimizeMap,
  resourcesMap: Record<string, JungleResourceMap>,
  manifestXML: xmlUtil.Document,
  options: BuildConfig
) {
  const state = await analyze(fnMap, resourcesMap, manifestXML, options, true);
  if (Object.values(fnMap).every(({ ast }) => ast != null)) {
    reportMissingSymbols(state, options);
  }

  const typeMap = await analyze_module_types(state);

  const diagnostics: Record<string, Diagnostic[]> | undefined =
    state.diagnostics && (await resolveDiagnosticsMap(state.diagnostics));

  if (state.config?.checkBuildPragmas) {
    Object.values(fnMap).forEach(
      (f) => f.ast && pragmaChecker(state, f.ast, diagnostics?.[f.name])
    );
  }

  return { fnMap: fnMap as Analysis["fnMap"], state, typeMap };
}
