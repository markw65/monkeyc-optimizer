import { mctree } from "@markw65/prettier-plugin-monkeyc";
import { diagnostic, formatAst } from "../api";
import { hasProperty, isExpression, withLoc, wrap } from "../ast";
import {
  FunctionStateNode,
  ProgramStateAnalysis,
  StateNode,
} from "../optimizer-types";
import { buildTypeInfo } from "../type-flow";
import { every } from "../util";
import { couldBe } from "./could-be";
import { evaluate, InterpState, popIstate } from "./interp";
import {
  display,
  hasValue,
  mcExprFromType,
  mustBeFalse,
  mustBeTrue,
  typeFromTypespec,
  TypeTag,
} from "./types";

export function optimizeFunction(
  state: ProgramStateAnalysis,
  func: FunctionStateNode
) {
  const istate = buildTypeInfo(state, func);
  if (!istate) return;

  evaluate(
    {
      ...istate,
      pre(node) {
        return beforeEvaluate(this, node);
      },
      post(node) {
        return afterEvaluate(this, node);
      },
    },
    func.node.body!
  );
}

export function beforeEvaluate(
  istate: InterpState,
  node: mctree.Node
): mctree.Node | null | false {
  switch (node.type) {
    case "ConditionalExpression": {
      const alternate = popIstate(istate, node.alternate);
      const consequent = popIstate(istate, node.consequent);
      const test = popIstate(istate, node.test);
      const result = mustBeTrue(test.value)
        ? true
        : mustBeFalse(test.value)
        ? false
        : null;
      if (result !== null) {
        if (!test.embeddedEffects) {
          const arg = result ? consequent : alternate;
          istate.stack.push(arg);
          return result ? node.consequent : node.alternate;
        }
      }
      istate.stack.push(test, consequent, alternate);
      break;
    }
    case "IfStatement": {
      const test = popIstate(istate, node.test);
      const result = mustBeTrue(test.value)
        ? true
        : mustBeFalse(test.value)
        ? false
        : null;
      if (result !== null) {
        const rep = result ? node.consequent : node.alternate || false;
        if (!test.embeddedEffects) {
          return rep;
        }
        const estmt = wrap(
          { type: "ExpressionStatement", expression: node.test },
          node.loc
        );
        if (!rep) {
          return estmt;
        }
        if (rep.type === "BlockStatement") {
          rep.body.unshift(estmt);
          return rep;
        }
      }
      istate.stack.push(test);
      break;
    }
    case "WhileStatement":
    case "DoWhileStatement": {
      const test = popIstate(istate, node.test);
      if (!test.embeddedEffects) {
        if (mustBeFalse(test.value)) {
          return node.type === "WhileStatement" ? false : node.body;
        }
      }
      istate.stack.push(test);
      break;
    }
    case "BinaryExpression":
      if (
        node.operator === "has" &&
        node.right.type === "UnaryExpression" &&
        node.right.operator === ":"
      ) {
        const [left, right] = istate.stack.slice(-2);
        if (
          left.embeddedEffects ||
          right.embeddedEffects ||
          !hasValue(left.value) ||
          !hasValue(right.value) ||
          !(left.value.type & (TypeTag.Module | TypeTag.Class))
        ) {
          break;
        }
        const id = node.right.argument;
        if (
          every(left.value.value as StateNode | StateNode[], (m) => {
            if (hasProperty(m.decls, id.name)) return false;
            // This is overkill, since we've already looked up
            // node.left, but the actual lookup rules are complicated,
            // and embedded within state.lookup; so just defer to that.
            return (
              istate.state.lookup({
                type: "MemberExpression",
                object: node.left,
                property: id,
                computed: false,
              })[1] == null
            );
          })
        ) {
          popIstate(istate, node.right);
          popIstate(istate, node.left);
          const rep = wrap(
            { type: "Literal", value: false, raw: "false" },
            node.loc
          );
          istate.stack.push({
            value: { type: TypeTag.False },
            embeddedEffects: false,
            node: rep,
          });
          return rep;
        }
      } else {
        const level =
          istate.state.config?.checkTypes === "OFF"
            ? null
            : istate.state.config?.checkTypes || "WARNING";
        if (!level) break;
        if (node.operator === "==" || node.operator === "!=") {
          const [{ value: left }, { value: right }] = istate.stack.slice(-2);
          if (
            (left.type === TypeTag.Null && !(right.type & TypeTag.Null)) ||
            (right.type === TypeTag.Null && !(left.type & TypeTag.Null))
          ) {
            diagnostic(
              istate.state,
              node.loc,
              `This comparison seems redundant because ${formatAst(
                left.type === TypeTag.Null ? node.right : node.left
              )} should never be null`,
              level
            );
          }
        } else if (node.operator === "as") {
          const [{ value: left }] = istate.stack.slice(-1);
          const right = typeFromTypespec(istate.state, node.right);
          if (!couldBe(left, right)) {
            diagnostic(
              istate.state,
              node.loc,
              `The type ${display(left)} cannot be converted to ${display(
                right
              )} because they have nothing in common`,
              level
            );
          }
        }
      }
      break;

    case "LogicalExpression": {
      const [left, right] = istate.stack.slice(-2);
      const isAnd = node.operator === "&&" || node.operator === "and";
      if (isAnd ? mustBeFalse(left.value) : mustBeTrue(left.value)) {
        popIstate(istate, node.right);
        return node.left;
      }
      if (
        // bail if left could be anything other than bool/integer
        (left.value.type &
          (TypeTag.Boolean | TypeTag.Number | TypeTag.Long)) !==
          left.value.type ||
        // bail if left could be boolean AND it could be integer
        (left.value.type & TypeTag.Boolean &&
          left.value.type & (TypeTag.Number | TypeTag.Long)) ||
        // bail if right doesn't match left
        (right.value.type &
          (left.value.type & TypeTag.Boolean
            ? TypeTag.Boolean
            : TypeTag.Number | TypeTag.Long)) !==
          right.value.type
      ) {
        break;
      }
      if (isAnd ? !mustBeTrue(left.value) : !mustBeFalse(left.value)) {
        break;
      }
      if (!(left.value.type & ~TypeTag.Boolean)) {
        // the left type is boolean, so the
        // `&` or `|` would be a no-op. We
        // need to check that its side-effect
        // free. Just cheap checks for now.
        if (!left.embeddedEffects) {
          popIstate(istate, node.right);
          popIstate(istate, node.left);
          istate.stack.push(right);
          return node.right;
        }
      }

      const rep = node as unknown as mctree.BinaryExpression;
      rep.type = "BinaryExpression";
      rep.operator = isAnd ? "&" : "|";
      break;
    }
  }
  return null;
}

export function afterEvaluate(
  istate: InterpState,
  node: mctree.Node
): mctree.Node | null | false {
  switch (node.type) {
    case "IfStatement":
      if (
        node.alternate &&
        node.alternate.type === "BlockStatement" &&
        !node.alternate.body.length
      ) {
        delete node.alternate;
      }
      break;
  }
  if (isExpression(node) && node.type !== "Literal") {
    const top = istate.stack[istate.stack.length - 1];
    if (!top.embeddedEffects && hasValue(top.value)) {
      const rep = mcExprFromType(top.value);
      if (rep) {
        top.node = rep;
        return withLoc(rep, node, node);
      }
    }
  }
  return null;
}