import { mctree } from "@markw65/prettier-plugin-monkeyc";
import { formatAst, traverseAst } from "./api";

export function pragmaChecker(
  ast: mctree.Program,
  diagnostics:
    | NonNullable<ProgramState["diagnostics"]>[string]
    | null
    | undefined
) {
  const comments = ast.comments;
  if (!comments) return;
  diagnostics = diagnostics
    ?.slice()
    .sort((d1, d2) =>
      d1.loc.start < d2.loc.start ? -1 : d1.loc.start == d2.loc.start ? 0 : 1
    );
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

      throw new Error(
        `Build pragma '${comment.value}' is invalid. In ${
          comment.loc!.source
        }:${comment.loc!.start.line}`
      );
    }
  };
  const matcher = (quote: string, needle: string, haystack: string) => {
    if (quote == '"') {
      return haystack.includes(needle);
    }
    const re = new RegExp(needle);
    return re.test(haystack);
  };
  next();
  traverseAst(ast, (node) => {
    if (index >= comments.length) return false;
    if (node.start && node.start >= (comment.end || Infinity)) {
      const { kind, quote, needle } = matchers.shift()!;
      if (kind === "match") {
        if (
          !matcher(quote, needle, formatAst(node).replace(/([\r\n]|\s)+/g, " "))
        ) {
          throw new Error(
            `Didn't find '${needle}' at ${comment.loc!.source}:${
              comment.loc!.start.line
            }`
          );
        }
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
          if (a.end.line === b.end.line && a.end.column >= b.end.column) {
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
          throw new Error(
            `Missing error message '${needle} at ${comment.loc!.source}:${
              comment.loc!.start.line
            }`
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
}
