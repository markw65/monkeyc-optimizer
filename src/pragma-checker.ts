import { mctree } from "@markw65/prettier-plugin-monkeyc";
import { checkCompilerVersion, diagnostic, formatAstLongLines } from "./api";
import { traverseAst } from "./ast";
import { Diagnostic, ProgramStateAnalysis } from "./optimizer-types";

export function pragmaChecker(
  state: ProgramStateAnalysis,
  ast: mctree.Program,
  diagnostics: Diagnostic[] | null | undefined
) {
  const comments = ast.comments;
  if (!comments) return Promise.resolve();
  diagnostics = diagnostics
    ?.slice()
    .sort((d1, d2) => d1.loc.start.offset - d2.loc.start.offset);
  let diagIndex = 0;
  let index = -1;
  let comment: mctree.Comment;
  let matchers: { kind: string; quote: string; needle: string }[];
  const next = () => {
    while (++index < comments.length) {
      comment = comments[index];
      let match = comment.value.match(/^\s*@(match|expect)\s+(.+)/);
      if (!match) continue;
      const kind = match[1];
      let str = match[2];
      const verCheck = checkCompilerVersion(
        str.replace(/\s.*/, ""),
        state.sdkVersion || 0
      );
      if (verCheck === false) continue;
      if (verCheck === true) {
        str = str.replace(/^\S+\s+/, "");
      }
      matchers = [];
      while (
        (match = str.match(/^([/%&#@"])(.+?(?<!\\)(?:\\{2})*)\1(\s+|$)/))
      ) {
        matchers.push({ kind, quote: match[1], needle: match[2] });
        str = str.substring(match[0].length);
        if (!str.length) break;
      }
      if (!str.length) break;
      if (!matchers.length) {
        match = str.match(/^(\S+)\s+$/);
        if (match) {
          matchers.push({ kind, quote: '"', needle: match[1] });
          break;
        }
      }

      diagnostic(
        state,
        comment,
        `Build pragma '${comment.value}' is invalid`,
        "ERROR"
      );
    }
  };
  const matcher = (quote: string, needle: string, haystack: string) => {
    if (quote === '"') {
      return haystack.includes(needle);
    }
    const re = new RegExp(
      needle.replace(
        /@([-\d.\w]+|"[^"]*")/g,
        (_match, pat) =>
          `(?:${pat}|pre_${pat
            .replace(/^([a-zA-Z_]+\.)*/, "")
            .replace(/\W/g, "_")}(?:_\\d+)?)`
      )
    );
    return re.test(haystack);
  };
  next();
  let promise = Promise.resolve();
  traverseAst(ast, (node) => {
    if (
      index >= comments.length ||
      node.type === "Line" ||
      node.type === "Block" ||
      node.type === "MultiLine"
    ) {
      return false;
    }
    if (node.start && node.start >= (comment.end || Infinity)) {
      const { kind, quote, needle } = matchers.shift()!;
      const thisComment = comment;
      if (kind === "match") {
        promise = promise.then(() =>
          formatAstLongLines(node).then((haystack) => {
            haystack = haystack
              .replace(/([\r\n]|\s)+/g, " ")
              .replace(/\b\w+\s\/\*>([\w.]+)<\*\//g, "$1");
            if (!matcher(quote, needle, haystack)) {
              matcher(quote, needle, haystack);
              diagnostic(
                state,
                thisComment,
                `Didn't find '${needle}' in '${haystack}'`,
                "ERROR"
              );
            }
          })
        );
      } else if (kind === "expect") {
        const locCmp = (
          a: NonNullable<typeof diagnostics>[number]["loc"],
          b: typeof node.loc
        ) => {
          if (!b) return -1;
          if (a.start.line < b.start.line) return -1;
          if (
            a.start.line === b.start.line &&
            a.start.column < b.start.column
          ) {
            return -1;
          }
          if (a.end.line > b.end.line) return 1;
          if (a.end.line === b.end.line && a.end.column > b.end.column) {
            return 1;
          }
          return 0;
        };
        let found = false;
        if (diagnostics) {
          while (true) {
            if (diagIndex >= diagnostics.length) {
              diagnostics = null;
              break;
            }

            const diag = diagnostics[diagIndex];
            const cmp = locCmp(diag.loc, node.loc);
            if (cmp > 0) {
              break;
            }
            diagIndex++;
            if (cmp < 0) continue;
            if (matcher(quote, needle, diag.message)) {
              found = true;
              diag.type = "INFO";
            }
          }
        }
        if (!found) {
          diagnostic(
            state,
            thisComment,
            `Missing error message '${needle}`,
            "ERROR"
          );
        }
      }
      if (matchers.length) {
        // if we're checking a series of nodes, we need
        // to skip over this one.
        return false;
      }
      next();
    }
    return null;
  });
  return promise;
}
