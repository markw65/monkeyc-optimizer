import { mctree } from "@markw65/prettier-plugin-monkeyc";
import { formatAst, traverseAst } from "./api";

export function pragmaChecker(ast: mctree.Program) {
  const comments = ast.comments;
  if (!comments) return;
  let index = -1;
  let comment: mctree.Comment;
  let matchers: { quote: string; needle: string }[];
  const next = () => {
    while (++index < comments.length) {
      comment = comments[index];
      let match = comment.value.match(/^\s*@match\s+(.+)/);
      if (!match) continue;
      let str = match[1];
      matchers = [];
      while (
        (match = str.match(/^([/%&#@"])(.+?(?<!\\)(?:\\{2})*)\1(\s+|$)/))
      ) {
        matchers.push({ quote: match[1], needle: match[2] });
        str = str.substring(match[0].length);
        if (!str.length) break;
      }
      if (!str.length) break;
      if (!matchers.length) {
        match = str.match(/^(\S+)\s+$/);
        if (match) {
          matchers.push({ quote: '"', needle: match[1] });
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
  next();
  traverseAst(ast, (node) => {
    if (index >= comments.length) return false;
    if (node.start && node.start >= (comment.end || Infinity)) {
      const { quote, needle } = matchers.shift()!;
      const haystack = formatAst(node).replace(/[\r\n]/g, " ");
      let found = false;
      if (quote == '"') {
        found = haystack.includes(needle);
      } else {
        const re = new RegExp(needle);
        found = re.test(haystack);
      }

      if (!found) {
        throw new Error(
          `Didn't find '${needle}' at ${comment.loc!.source}:${
            comment.loc!.start.line
          }`
        );
      }
      if (!matchers.length) {
        next();
      }
      return false;
    }
    return null;
  });
}
