import { mctree } from "@markw65/prettier-plugin-monkeyc";
import { formatAst, traverseAst } from "./api";

export function pragmaChecker(ast: mctree.Program) {
  const comments = ast.comments;
  if (!comments) return;
  let index = -1;
  let comment: mctree.Comment;
  const next = () => {
    while (++index < comments.length) {
      comment = comments[index];
      if (comment.value.match(/^\s*@match\s+/)) {
        break;
      }
    }
  };
  next();
  traverseAst(ast, (node) => {
    if (index >= comments.length) return false;
    if (node.start && node.start >= (comment.end || Infinity)) {
      let match =
        comment.value.match(
          /^\s*@match\s+([/%&#@"])(.+(?<!\\)(?:\\{2})*)\1\s+$/
        ) || comment.value.match(/^\s*@match\s+(\S+)\s+$/);
      if (!match) {
        throw new Error(
          `Build pragma '${comment.value}' is invalid. In ${
            comment.loc!.source
          }:${comment.loc!.start.line}`
        );
      }
      const haystack = formatAst(node).replace(/[\r\n]/g, " ");
      let found = false;
      let needle = match[1];
      if (match.length == 2) {
        found = haystack.includes(needle);
      } else {
        if (needle == '"') {
          found = haystack.includes((needle = match[2]));
        } else {
          const re = new RegExp((needle = match[2]));
          found = re.test(haystack);
        }
      }
      if (!found) {
        throw new Error(
          `Didn't find '${needle}' in ${comment.loc!.source}:${
            comment.loc!.start.line
          }`
        );
      }
      next();
    }
    return null;
  });
}
