import { mctree } from "@markw65/prettier-plugin-monkeyc";
import {
  getLiteralNode,
  hasProperty,
  isExpression,
  withLoc,
  wrap,
} from "../ast";
import { unused } from "../inliner";
import {
  FunctionStateNode,
  ProgramStateAnalysis,
  StateNode,
} from "../optimizer-types";
import { buildTypeInfo } from "../type-flow";
import { every } from "../util";
import {
  deEnumerate,
  evaluate,
  InterpStackElem,
  InterpState,
  mustBeIdentical,
  popIstate,
  tryPop,
} from "./interp";
import { evaluateBinaryTypes } from "./interp-binary";
import {
  hasValue,
  mcExprFromType,
  mustBeFalse,
  mustBeTrue,
  typeFromLiteral,
  TypeTag,
} from "./types";

export function optimizeFunction(
  state: ProgramStateAnalysis,
  func: FunctionStateNode
) {
  const istate = buildTypeInfo(state, func, true);
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
    case "ExpressionStatement": {
      if (node.expression.type !== "Literal") {
        const expression = popIstate(istate, node.expression);
        if (expression.embeddedEffects) {
          istate.stack.push(expression);
        } else {
          const rep = withLoc(
            { type: "Literal", value: null, raw: "null" },
            node,
            node
          );
          istate.stack.push({
            value: { type: TypeTag.Null },
            embeddedEffects: false,
            node: rep,
          });
          node.expression = rep;
        }
      }
      break;
    }
    case "ConditionalExpression": {
      let alternate = tryPop(istate, node.alternate);
      let consequent = tryPop(istate, node.consequent);
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
      if (
        node.alternate &&
        node.test.type === "UnaryExpression" &&
        node.test.operator === "!" &&
        test.value.type === TypeTag.Boolean
      ) {
        const alternateNode = node.alternate;
        node.alternate = node.consequent;
        node.consequent = alternateNode;
        const tmp = alternate;
        alternate = consequent;
        consequent = tmp;
        test.node = node.test = node.test.argument;
      }
      if (
        test.value.type === TypeTag.Boolean &&
        ((consequent.value.type === TypeTag.True &&
          alternate.value.type === TypeTag.False) ||
          (consequent.value.type === TypeTag.False &&
            alternate.value.type === TypeTag.True)) &&
        !consequent.embeddedEffects &&
        !alternate.embeddedEffects
      ) {
        if (consequent.value.type === TypeTag.False) {
          test.node = wrap(
            {
              type: "UnaryExpression",
              operator: "!",
              argument: node.test,
              prefix: true,
            },
            test.node.loc
          );
        }
        istate.stack.push(test);
        return test.node;
      }
      istate.stack.push(test, consequent, alternate);
      break;
    }
    case "IfStatement": {
      if (
        node.alternate &&
        node.alternate.type === "BlockStatement" &&
        !node.alternate.body.length
      ) {
        delete node.alternate;
      }
      const test = popIstate(istate, node.test);
      if (
        !node.alternate &&
        node.consequent.type === "BlockStatement" &&
        !node.consequent.body.length
      ) {
        const ret = withLoc(node.consequent, node.test, node.test);
        const u = test.embeddedEffects && unused(istate.state, node.test);
        if (u) {
          node.consequent.body = u;
        }
        return ret;
      }
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
      if (
        node.alternate &&
        node.test.type === "UnaryExpression" &&
        node.test.operator === "!" &&
        test.value.type === TypeTag.Boolean
      ) {
        const alternate = node.alternate;
        node.alternate = node.consequent;
        node.consequent = alternate;
        test.node = node.test = node.test.argument;
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
    case "UnaryExpression":
      if (node.operator === "-") {
        const [arg] = istate.stack.slice(-1);
        if (
          (arg.value.type & (TypeTag.Number | TypeTag.Long)) ===
            arg.value.type &&
          arg.value.value == null
        ) {
          const leftType = { type: TypeTag.Number, value: 0 } as const;
          const rep = withLoc<mctree.BinaryExpression>(
            {
              type: "BinaryExpression",
              operator: "-",
              left: withLoc(mcExprFromType(leftType)!, node.argument, false),
              right: node.argument,
            },
            node
          );
          popIstate(istate, node.argument);
          istate.stack.push({
            value: evaluateBinaryTypes("-", leftType, arg.value),
            embeddedEffects: arg.embeddedEffects,
            node: rep,
          });
          return rep;
        }
      }
      break;
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
        if (node.operator !== "as") {
          const left = tryDeEnumerate(istate, node.left, -2);
          if (left) node.left = left;
          const right = tryDeEnumerate(istate, node.right, -1);
          if (right) node.right = right;
        }
        const rep = tryCommuteAndAssociate(istate, node);
        if (rep) return rep;
      }
      break;

    case "LogicalExpression": {
      const right = tryPop(istate, node.right);
      const left = popIstate(istate, node.left);
      const isAnd = node.operator === "&&" || node.operator === "and";
      if (isAnd ? mustBeFalse(left.value) : mustBeTrue(left.value)) {
        istate.stack.push(left);
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
        istate.stack.push(left);
        istate.stack.push(right);
        break;
      }
      if (
        right.value.type === (isAnd ? TypeTag.True : TypeTag.False) &&
        !right.embeddedEffects &&
        (left.value.type & TypeTag.Boolean) === left.value.type
      ) {
        istate.stack.push(left);
        return node.left;
      }
      if (
        right.value.type === (isAnd ? TypeTag.False : TypeTag.True) &&
        !left.embeddedEffects &&
        (left.value.type & TypeTag.Boolean) === left.value.type
      ) {
        istate.stack.push(right);
        return node.right;
      }

      istate.stack.push(left);
      istate.stack.push(right);
      if (isAnd ? !mustBeTrue(left.value) : !mustBeFalse(left.value)) {
        break;
      }
      if (!(left.value.type & ~TypeTag.Boolean)) {
        // the left type is boolean, so the
        // `&` or `|` would be a no-op. We
        // need to check that its side-effect
        // free. Just cheap checks for now.
        if (!left.embeddedEffects) {
          istate.stack.splice(-2, 2, right);
          return node.right;
        }
      }

      const rep = node as unknown as mctree.BinaryExpression;
      rep.type = "BinaryExpression";
      rep.operator = isAnd ? "&" : "|";
      break;
    }
    case "ForStatement": {
      if (
        node.update?.type === "Literal" ||
        (node.update?.type === "SequenceExpression" &&
          node.update.expressions.length === 0)
      ) {
        popIstate(istate, node.update);
        delete node.update;
      }
      if (
        node.init?.type === "Literal" ||
        (node.init?.type === "SequenceExpression" &&
          node.init.expressions.length === 0)
      ) {
        delete node.init;
        const depth = -1 - (node.update ? 1 : 0) - (node.test ? 1 : 0);
        istate.stack.splice(depth, 1);
      }
      break;
    }
    case "BlockStatement": {
      for (let i = node.body.length; i--; ) {
        const stmt = node.body[i];
        if (stmt.type === "VariableDeclaration" && !stmt.declarations.length) {
          node.body.splice(i, 1);
        } else if (
          stmt.type === "BlockStatement" &&
          stmt.body.every((s) => s.type !== "VariableDeclaration")
        ) {
          node.body.splice(i, 1, ...stmt.body);
        }
      }
      break;
    }
    case "SequenceExpression": {
      for (let i = node.expressions.length; i--; ) {
        const expr = node.expressions[i];
        if (expr.type === "Literal") {
          istate.stack.splice(i - node.expressions.length, 1);
          node.expressions.splice(i, 1);
        }
      }
      break;
    }
    case "AssignmentExpression": {
      if (node.operator === "=") {
        let selfAssign = false;
        if (
          node.left.type === "Identifier" &&
          node.right.type === "Identifier" &&
          node.left.name === node.right.name
        ) {
          selfAssign = true;
        } else {
          const [left, right] = istate.stack.slice(-2);
          if (
            !left.embeddedEffects &&
            !right.embeddedEffects &&
            mustBeIdentical(left.value, right.value)
          ) {
            selfAssign = true;
          }
        }
        if (selfAssign) {
          popIstate(istate, node.right);
          popIstate(istate, node.left);
          const rep = withLoc(
            { type: "Literal", value: null, raw: "null" },
            node,
            node
          );
          istate.stack.push({
            value: { type: TypeTag.Null },
            embeddedEffects: false,
            node: rep,
          });
          return rep;
        }
      }
      break;
    }
  }
  return null;
}

export function afterEvaluate(
  istate: InterpState,
  node: mctree.Node
): mctree.Node | null | false {
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

function identity(
  istate: InterpState,
  node: mctree.BinaryExpression,
  left: InterpStackElem,
  right: InterpStackElem,
  allowedTypes: TypeTag,
  target: number
) {
  if (
    hasValue(right.value) &&
    right.value.type & allowedTypes &&
    !(left.value.type & ~allowedTypes) &&
    Number(right.value.value) === target
  ) {
    // a +/- 0 => a
    // but we still need to check that the type of the zero
    // doesn't change the type of the result.
    if (
      right.value.type === TypeTag.Number ||
      (right.value.type === TypeTag.Long &&
        !(left.value.type & ~(TypeTag.Long | TypeTag.Double))) ||
      (right.value.type === TypeTag.Float &&
        !(left.value.type & ~(TypeTag.Float | TypeTag.Double))) ||
      (right.value.type === TypeTag.Double &&
        left.value.type === TypeTag.Double)
    ) {
      istate.stack.pop();
      return node.left;
    }
  }
  return null;
}

function zero(
  istate: InterpState,
  node: mctree.BinaryExpression,
  left: InterpStackElem,
  right: InterpStackElem,
  allowedTypes: TypeTag,
  target: number
) {
  if (
    hasValue(right.value) &&
    right.value.type & allowedTypes &&
    !(left.value.type & ~allowedTypes) &&
    Number(right.value.value) === target
  ) {
    // a * 0 => 0
    // but we still need to check that the type of a
    // doesn't change the type of the zero.
    if (
      (right.value.type === TypeTag.Number &&
        left.value.type === TypeTag.Number) ||
      (right.value.type === TypeTag.Long &&
        !(left.value.type & ~(TypeTag.Long | TypeTag.Number))) ||
      (right.value.type === TypeTag.Float &&
        !(left.value.type & ~(TypeTag.Float | TypeTag.Number))) ||
      right.value.type === TypeTag.Double
    ) {
      istate.stack.splice(-2, 1);
      return node.right;
    }
  }
  return null;
}

function isNegatedNode(node: mctree.Expression) {
  if (node.type === "UnaryExpression") {
    if (node.operator === "-") {
      return node.argument;
    }
  } else if (node.type === "BinaryExpression") {
    if (node.operator === "-" && node.left.type === "Literal") {
      // we have to be conservative here. 0L - x could be promoting x to Long
      // (similarly for Float and Double)
      if (
        node.left.value === 0 &&
        typeFromLiteral(node.left).type === TypeTag.Number
      ) {
        return node.right;
      }
    }
  }
  return null;
}

function tryIdentity(
  istate: InterpState,
  node: Extract<mctree.Node, { type: "BinaryExpression" }>,
  left: InterpStackElem,
  right: InterpStackElem
) {
  switch (node.operator) {
    case "+":
    case "-": {
      const rep = identity(istate, node, left, right, TypeTag.Numeric, 0);
      if (rep) return rep;
      const negated = isNegatedNode(node.right);
      if (negated) {
        // We can convert a +/- -b to a -/+ b, but we have to know
        // something about the types. eg if b is Number, with the
        // value -2^31, negating b will leave the value as -2^31.
        // This doesn't matter if the a is also Number, but if
        // a might be Long, Float or Double, we would change the
        // result. Similarly for Long and -2^63
        if (
          !((left.value.type | right.value.type) & ~TypeTag.Numeric) &&
          (right.value.type & TypeTag.Number // Negating -2^31 goes wrong if left is a wider type
            ? !(
                left.value.type &
                (TypeTag.Long | TypeTag.Float | TypeTag.Double)
              )
            : right.value.type & TypeTag.Long // Negating -2^63 goes wrong if left is a float/double
            ? !(left.value.type & (TypeTag.Float | TypeTag.Double))
            : true)
        ) {
          right.value = evaluateBinaryTypes(
            "-",
            { type: TypeTag.Number, value: 0 },
            right.value
          );
          node.right = right.node = negated;
          node.operator = node.operator === "+" ? "-" : "+";
        }
      }
      break;
    }
    case "*": {
      const rep = zero(istate, node, left, right, TypeTag.Numeric, 0);
      if (rep) return rep;
      // fall through
    }
    case "/": {
      const rep = identity(istate, node, left, right, TypeTag.Numeric, 1);
      if (rep) return rep;
      break;
    }
    case "|": {
      const rep = zero(
        istate,
        node,
        left,
        right,
        TypeTag.Number | TypeTag.Long,
        -1
      );
      if (rep) return rep;
      // fall through
    }
    case "^": {
      const rep = identity(
        istate,
        node,
        left,
        right,
        TypeTag.Number | TypeTag.Long,
        0
      );
      if (rep) return rep;
      break;
    }
    case "&": {
      const rep =
        zero(istate, node, left, right, TypeTag.Number | TypeTag.Long, 0) ||
        identity(istate, node, left, right, TypeTag.Number | TypeTag.Long, -1);
      if (rep) return rep;
      break;
    }
  }
  return null;
}

function tryCommuteAndAssociate(
  istate: InterpState,
  node: Extract<mctree.Node, { type: "BinaryExpression" }>
) {
  let [left, right] = istate.stack.slice(-2);
  // no need to do anything if both sides are constants
  if (!right || (hasValue(left.value) && hasValue(right.value))) {
    return null;
  }
  switch (node.operator) {
    case "-":
      if (
        (left.value.type === TypeTag.Number &&
          left.value.value === -1 &&
          (right.value.type & (TypeTag.Number | TypeTag.Long)) ===
            right.value.type) ||
        (left.value.type === TypeTag.Long &&
          left.value.value === -1n &&
          right.value.type === TypeTag.Long)
      ) {
        const rep = withLoc<mctree.UnaryExpression>(
          {
            type: "UnaryExpression",
            operator: "~",
            argument: node.right,
            prefix: true,
          },
          node
        );
        istate.stack.splice(-2, 2, {
          node: rep,
          value: evaluateBinaryTypes("-", left.value, right.value),
          embeddedEffects: right.embeddedEffects,
        });
        return rep;
      }
      if (tryReAssociate(istate, node, left, right)) {
        [left, right] = istate.stack.slice(-2);
      }
      break;
    case "+":
      // Addition is only commutative/associative if both arguments
      // are numeric, or one argument is Number, and the other is Char
      if (
        left.value.type & ~(TypeTag.Numeric | TypeTag.Char) ||
        right.value.type & ~(TypeTag.Numeric | TypeTag.Char) ||
        left.value.type & right.value.type & TypeTag.Char
      ) {
        break;
      }
    // fallthrough
    case "*":
    case "&":
    case "|":
    case "^":
      // flip the left argument to the right if the left has
      // a known value, but the right does not, or if the
      // top operator is additive, and the left operand is
      // negated, and the right operand is not.
      if (
        !left.embeddedEffects &&
        (hasValue(left.value) ||
          (!right.embeddedEffects &&
            node.operator === "+" &&
            node.left.type === "UnaryExpression" &&
            node.left.operator === "-" &&
            (node.right.type !== "UnaryExpression" ||
              node.right.operator !== "-")))
      ) {
        const l = node.left;
        node.left = node.right;
        node.right = l;
        istate.stack.splice(-2, 2, right, left);
        const r = right;
        right = left;
        left = r;
      }
      if (tryReAssociate(istate, node, left, right)) {
        [left, right] = istate.stack.slice(-2);
      }
  }
  return tryIdentity(istate, node, left, right);
}

/*
 * Try to reorder (a op K1) op K2 => a op (K1 op K2),
 * and fold K1 op K2.
 *
 * Failing that,
 * Try to reorder (a op K1) op (b op K2) as
 * (a op b) op (K1 op K2), and fold K1 op K2.
 *
 * Failing that,
 * Try to reorder (a op K) op b => (a op b) op K
 * so that constants float up and to the right.
 * This helps because now ((a op K1) op b) op K2
 * becomes ((a op b) op K1) op K2, and we can
 * fold K1 op K2 by the first transformation.
 *
 * Floating point arithmetic isn't really associative
 * though, so we mostly suppress this when Floats
 * and Doubles may be involved; except that
 * (a + K1) + K2 can be safely converted to
 * a + (K1 + K2) if K1 and K2 have the same sign.
 */
function tryReAssociate(
  istate: InterpState,
  node: mctree.BinaryExpression,
  left: InterpStackElem,
  right: InterpStackElem
) {
  if (
    node.left.type !== "BinaryExpression" ||
    (node.left.operator !== node.operator &&
      !(node.operator === "+" && node.left.operator === "-") &&
      !(node.operator === "-" && node.left.operator === "+"))
  ) {
    return false;
  }

  let leftLit = getLiteralNode(node.left.right);
  if (!leftLit) {
    if (node.left.operator !== "-") return false;
    leftLit = getLiteralNode(node.left.left);
    if (!leftLit) return false;
    const leftLeft = evaluate(istate, leftLit);
    if (!hasValue(leftLeft.value)) return false;
    if (!hasValue(right.value)) return false;
    // (K - x) + C => (K + C) - x
    // (K - x) - C => (K - C) - x
    if (
      leftLeft.value.type & (TypeTag.Float | TypeTag.Double) ||
      right.value.type & (TypeTag.Float | TypeTag.Double)
    ) {
      // we don't want to fold constants of differing signs because it could be
      // there for rounding purposes
      const rsign =
        (right.value.value as number) < 0 === (node.operator === "+");
      const lsign = (leftLeft.value.value as number) < 0;
      if (lsign !== rsign) return false;
    }

    const tmpNode: mctree.BinaryExpression = {
      type: "BinaryExpression",
      operator: node.operator,
      left: node.left.left,
      right: node.right,
    };
    const repType = evaluate(istate, tmpNode);
    if (!hasValue(repType.value)) return false;
    const repNode = mcExprFromType(repType.value);
    if (!repNode) return false;

    node.right = node.left.right;
    node.left = repNode;
    node.operator = "-";
    istate.stack.splice(-2, 2, repType, left);
    left.node = node.right;
    repType.node = repNode;
    return true;
  }
  const leftRight = evaluate(istate, leftLit);
  if (!hasValue(leftRight.value)) return false;

  if (hasValue(right.value)) {
    // (ll + lr) + r => ll + (r + lr)
    // (ll - lr) - r => ll - (r + lr)
    // (ll + lr) - r => ll + (r - lr)
    // (ll - lr) + r => ll - (r - lr)
    const tmpNode: mctree.BinaryExpression = {
      type: "BinaryExpression",
      operator:
        node.operator === "+" || node.operator === "-"
          ? node.operator === node.left.operator
            ? "+"
            : "-"
          : node.operator,
      left: node.right,
      right: node.left.right,
    };
    if (tmpNode.operator === "+" || tmpNode.operator === "-") {
      if (
        leftRight.value.type & (TypeTag.Float | TypeTag.Double) ||
        right.value.type & (TypeTag.Float | TypeTag.Double)
      ) {
        // we don't want to fold "a + 1.0 - 1.0" because
        // it could be there for rounding purposes
        const lsign = (right.value.value as number) < 0;
        const rsign =
          (leftRight.value.value as number) < 0 === (tmpNode.operator === "+");
        if (lsign !== rsign) return false;
      }
    }
    const repType = evaluate(istate, tmpNode);
    if (!hasValue(repType.value)) return false;
    const repNode = mcExprFromType(repType.value);
    if (!repNode) return false;
    left.node = node.left = node.left.left;
    node.right = repNode;
    istate.stack.splice(-1, 1, repType);
    repType.node = repNode;
    return true;
  }
  if (
    leftRight.value.type !== left.value.type ||
    leftRight.value.type !== right.value.type ||
    leftRight.value.type & (TypeTag.Float | TypeTag.Double)
  ) {
    return false;
  }
  if (
    node.right.type === "BinaryExpression" &&
    (node.right.operator === node.operator ||
      ((node.operator === "+" || node.operator === "-") &&
        (node.right.operator === "+" || node.right.operator === "-")))
  ) {
    // (a + K1) + (b + K2) => (a + b) + (K1 + K2)
    const rr = getLiteralNode(node.right.right);
    if (!rr) return false;
    const rightRight = evaluate(istate, rr);
    if (!hasValue(rightRight.value)) return false;
    const rightOp =
      node.operator === "+" || node.operator === "-"
        ? ((node.left.operator === "+") === (node.right.operator === "+")) ===
          (node.operator === "+")
          ? "+"
          : "-"
        : node.operator;
    const topOp = node.left.operator;
    const leftOp = node.operator;
    const rightType = evaluateBinaryTypes(
      rightOp,
      leftRight.value,
      rightRight.value
    );
    if (!hasValue(rightType)) return false;
    const repNode = mcExprFromType(rightType);
    if (!repNode) return false;
    node.left.right = node.right.left;
    node.right = repNode;
    node.left.operator = leftOp;
    node.operator = topOp;
    istate.stack.splice(-1, 1, {
      value: rightType,
      node: repNode,
      embeddedEffects: false,
    });
    return true;
  }
  const op = node.operator;
  node.operator = node.left.operator;
  node.left.operator = op;
  leftRight.node = node.left.right;
  node.left.right = node.right;
  node.right = leftRight.node;
  istate.stack.splice(-1, 1, leftRight);
  return true;
}

export function tryDeEnumerate(
  istate: InterpState,
  node: mctree.Expression,
  elem: number
): mctree.Expression | null {
  if (
    node.type === "BinaryExpression" &&
    node.operator === "as" &&
    node.right.ts.length === 1 &&
    typeof node.right.ts[0] === "string"
  ) {
    elem += istate.stack.length;
    const item = istate.stack[elem];
    istate.stack[elem] = {
      value: deEnumerate(item.value),
      embeddedEffects: item.embeddedEffects,
      node: node.left,
    };
    return node.left;
  }
  return null;
}
