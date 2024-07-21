import { mctree } from "@markw65/prettier-plugin-monkeyc";
import { isExpression, isStatement, mayThrow } from "./ast";
import {
  ProgramStateAnalysis,
  FunctionStateNode,
  ModuleStateNode,
  ClassStateNode,
  ProgramStateStack,
  ProgramStateNode,
} from "./optimizer-types";
import { forEach, pushUnique } from "./util";

export type RootStateNode =
  | ProgramStateNode
  | FunctionStateNode
  | ModuleStateNode
  | ClassStateNode;

const Terminals = {
  BreakStatement: "break",
  ContinueStatement: "continue",
  ReturnStatement: null,
  ThrowStatement: "throw",
} as const;

export type BaseEvent = { type: string; mayThrow: boolean };
type EventConstraint<_T> = BaseEvent;

type LocalInfo<T extends EventConstraint<T>> = {
  node: mctree.Node;
  break?: Block<T>;
  continue?: Block<T>;
  throw?: Block<T>;
  finally?: Block<T>;
  posttry?: Block<T>;
  postfinally?: Set<Block<T>>;
};

type TestContext<T extends EventConstraint<T>> =
  | {
      node: mctree.Node;
      true?: undefined;
      false?: undefined;
    }
  | {
      node: mctree.Node;
      true: Block<T>;
      false: Block<T>;
    };

type LocalAttributeStack<T extends EventConstraint<T>> = LocalInfo<T>[];

export type Block<T extends EventConstraint<T>> = {
  node?: mctree.Node;
  preds?: Block<T>[];
  succs?: Block<T>[];
  expreds?: Block<T>[];
  exsucc?: Block<T>;
  // Garmin's uninitialized variable checker sometimes
  // includes bogus edges in the control flow graph.
  // In particular, a switch with a default still has
  // an edge as if you could avoid all the cases and the
  // default. We need to mimic this in order to avoid
  // killing dead stores and ending up with code that
  // garmin won't compile.
  bogopred?: Block<T>;
  events?: T[];
};

class LocalState<T extends EventConstraint<T>> {
  stack: LocalAttributeStack<T> = [];
  info = new Map<mctree.Node, LocalInfo<T>>();
  curBlock: Block<T> = {};
  unreachable = false;

  push(node: mctree.Node) {
    const top: LocalInfo<T> = { node };
    this.stack.push(top);
    return top;
  }

  pop() {
    return this.stack.pop();
  }

  top(depth?: number) {
    return this.stack[this.stack.length - (depth || 1)];
  }

  addEdge(from: Block<T>, to: Block<T>) {
    if (!from.succs) {
      from.succs = [to];
    } else {
      pushUnique(from.succs, to);
    }
    if (!to.preds) {
      to.preds = [from];
    } else {
      pushUnique(to.preds, from);
    }
  }

  newBlock(block?: Block<T>) {
    if (!block) block = {};
    if (!this.unreachable) {
      this.addEdge(this.curBlock, block);
    }
    this.unreachable = false;
    for (let i = this.stack.length; i--; ) {
      const si = this.stack[i];
      if (si.throw) {
        block.exsucc = si.throw;
        if (!si.throw.expreds) {
          si.throw.expreds = [block];
        } else {
          si.throw.expreds.push(block);
        }
        break;
      }
    }
    return (this.curBlock = block);
  }

  terminal(type: keyof typeof Terminals) {
    const re = Terminals[type];
    let finalies: Set<number> | null = null;
    for (let i = this.stack.length; i--; ) {
      const fin = this.stack[i].finally;
      if (fin && (re !== "throw" || !this.stack[i].throw)) {
        this.addEdge(this.curBlock, fin);
        if (!finalies) {
          finalies = new Set();
        }
        finalies.add(i);
      }
      if (!re) continue;
      const target = this.stack[i][re];
      if (target) {
        this.addEdge(this.curBlock, target);
        finalies?.forEach((i) => {
          const elm = this.stack[i];
          if (!elm.postfinally) {
            elm.postfinally = new Set();
          }
          elm.postfinally.add(target);
        });
        break;
      }
    }
    this.unreachable = true;
  }
}

export function buildReducedGraph<T extends EventConstraint<T>>(
  state: ProgramStateAnalysis,
  root: RootStateNode,
  refsForUpdate: boolean,
  notice: (
    node: mctree.Node,
    stmt: mctree.Node,
    mayThrow: boolean | 1,
    containedEvents: () => T[]
  ) => T | T[] | null
) {
  const { stack, pre, post } = state;
  const localState = new LocalState<T>();
  const ret = localState.curBlock;
  const processOne = (
    rootNode: NonNullable<RootStateNode["node"]>,
    rootStack: ProgramStateStack
  ) => {
    localState.push(rootNode);
    state.stack = [...rootStack];
    const stmtStack: mctree.Node[] = [rootNode];
    const testStack: TestContext<T>[] = [{ node: rootNode }];
    const allEvents = [] as T[];
    const eventsStack = [] as number[];

    let tryActive = 0;
    state.pre = function (node) {
      eventsStack.push(allEvents.length);
      if (
        localState.unreachable ||
        (this.inType && node.type !== "EnumDeclaration")
      ) {
        return [];
      }
      if (
        !localState.curBlock.node &&
        (isStatement(node) || isExpression(node))
      ) {
        localState.curBlock.node = node;
      }

      let topTest = testStack[testStack.length - 1];
      if (topTest.node !== node && topTest.true) {
        testStack.push((topTest = { node }));
      }
      if (isStatement(node)) {
        stmtStack.push(node);
      }
      switch (node.type) {
        case "ClassDeclaration":
        case "ModuleDeclaration":
        case "FunctionDeclaration":
          // don't descend into functions, unless its the target
          return rootNode === node ? ["body"] : [];
        case "AttributeList":
          return [];
        case "SwitchStatement": {
          const top = localState.push(node);
          top.break = {};
          this.traverse(node.discriminant);
          const testBlocks: Block<T>[] = [];
          let defaultSeen = false;
          node.cases.forEach((sc, i) => {
            if (sc.test) {
              this.traverse(sc.test);
              testBlocks[i] = localState.curBlock;
              localState.newBlock();
            } else {
              defaultSeen = true;
            }
          });
          const endOfTests = localState.curBlock;
          if (!defaultSeen) {
            localState.addEdge(endOfTests, top.break);
          }
          localState.unreachable = true;
          node.cases.forEach((sc, i) => {
            localState.newBlock();
            localState.addEdge(
              testBlocks[i] || endOfTests,
              localState.curBlock
            );
            sc.consequent.every((s) => {
              this.traverse(s);
              return !localState.unreachable;
            });
          });
          localState.newBlock(top.break);
          localState.unreachable = !top.break.preds;
          if (!localState.unreachable && defaultSeen) {
            top.break.bogopred = endOfTests;
          }
          return [];
        }
        case "DoWhileStatement":
        case "WhileStatement": {
          localState.push(node);
          const top = localState.top();
          top.break = {};
          top.continue = {};
          let head;
          if (node.type === "WhileStatement") {
            head = localState.newBlock(top.continue);
            const body = {};
            testStack.push({
              node: node.test,
              true: body,
              false: top.break,
            });
            this.traverse(node.test);
            localState.unreachable = true;
            localState.newBlock(body);
          } else {
            head = localState.newBlock();
          }
          this.traverse(node.body);
          if (node.type === "DoWhileStatement") {
            localState.newBlock(top.continue);
            testStack.push({
              node: node.test,
              true: head,
              false: top.break,
            });
            this.traverse(node.test);
            localState.unreachable = true;
          } else if (!localState.unreachable) {
            localState.addEdge(localState.curBlock, head);
          }
          localState.newBlock(top.break);
          return [];
        }
        case "TryStatement": {
          const top = localState.push(node);
          const catches = (top.throw = {});
          if (node.finalizer) {
            top.finally = {};
          }
          // This edge shouldn't exist, but we can trigger
          // (incorrect) "variable may not be initialized" errors
          // in the monkey c compiler without it.
          // https://forums.garmin.com/developer/connect-iq/i/bug-reports/incorrect-maybe-uninitialized-error
          localState.addEdge(localState.curBlock, top.throw);
          localState.newBlock();
          tryActive++;
          this.traverse(node.block);
          tryActive--;
          delete top.throw;
          top.posttry = {};
          const tryFallsThrough = !localState.unreachable;
          if (tryFallsThrough) {
            localState.addEdge(localState.curBlock, top.finally ?? top.posttry);
          }
          localState.unreachable = true;
          localState.newBlock(catches);
          if (node.handler) {
            this.traverse(node.handler);
            // Each "catch (ex instanceof Foo)" chains to the next,
            // but "catch (ex)" terminates the list. If the end
            // of the chain has a predecessor, its possible that
            // none of the conditions matched, so the exception
            // will propagate from there.
            if (localState.curBlock.preds) {
              localState.terminal("ThrowStatement");
            }
          }
          if (node.finalizer) {
            localState.unreachable = true;
            localState.newBlock(top.finally);
            delete top.finally;
            this.traverse(node.finalizer);
            if (!localState.unreachable) {
              if (tryFallsThrough) {
                localState.addEdge(localState.curBlock, top.posttry);
              }
              top.postfinally?.forEach((post) =>
                localState.addEdge(localState.curBlock, post)
              );
            }
            localState.terminal("ThrowStatement");
          }
          localState.unreachable = true;
          localState.newBlock(top.posttry);
          if (!top.posttry.preds) {
            localState.unreachable = true;
          }
          return [];
        }
        case "CatchClause": {
          const top = localState.top();
          if (!localState.curBlock.preds && !localState.curBlock.expreds) {
            return [];
          }
          const next = {};
          if (node.param && node.param.type === "BinaryExpression") {
            this.traverse(node.param);
            localState.addEdge(localState.curBlock, next);
            localState.newBlock();
          }
          this.traverse(node.body);
          if (!localState.unreachable) {
            localState.addEdge(
              localState.curBlock,
              top.finally ?? top.posttry!
            );
          }
          localState.unreachable = true;
          localState.newBlock(next);
          return [];
        }
        case "ForStatement": {
          const top = localState.push(node);
          if (node.init) this.traverse(node.init);
          const head = localState.newBlock();
          top.break = {};
          top.continue = {};
          if (node.test) {
            const body = {};
            testStack.push({
              node: node.test,
              true: body,
              false: top.break,
            });
            this.traverse(node.test);
            localState.unreachable = true;
            localState.newBlock(body);
          }
          this.traverse(node.body);
          localState.newBlock(top.continue);
          if (node.update) {
            this.traverse(node.update);
          }
          if (!localState.unreachable) {
            localState.addEdge(localState.curBlock, head);
          }
          // there is no fall through from the end of the loop
          // to the next block. The only way there is via break
          // or the test failing.
          localState.unreachable = true;
          localState.newBlock(top.break);
          if (!top.break.preds) {
            localState.unreachable = true;
          }
          return [];
        }
        case "IfStatement":
        case "ConditionalExpression": {
          const consequent = {};
          const alternate = {};
          const next: Block<T> = node.alternate ? {} : alternate;
          testStack.push({
            node: node.test,
            true: consequent,
            false: alternate,
          });
          this.traverse(node.test);
          localState.unreachable = true;
          if (topTest.true) {
            testStack.push({ ...topTest, node: node.consequent });
          } else {
            testStack.push({ node: node.consequent, true: next, false: next });
          }
          localState.newBlock(consequent);
          this.traverse(node.consequent);
          localState.unreachable = true;
          if (node.alternate) {
            if (topTest.true) {
              testStack.push({ ...topTest, node: node.alternate });
            } else {
              testStack.push({ node: node.alternate, true: next, false: next });
            }
            localState.newBlock(alternate);
            this.traverse(node.alternate);
            localState.unreachable = true;
          }
          if (next.preds) {
            /*
             * Given:
             * if (cond) {
             * } else if (cond2) {
             * } // no else
             *
             * cond2 will cause a branch to the second if's next block
             * But if topTest.true, we also need to ensure that next branches
             * to both true and false.
             *
             * So in *this* case, we have to skip the testStack.pop (or manually
             * add the edges here).
             */
            localState.newBlock(next);
          } else if (topTest.node === node) {
            testStack.pop();
          }
          return [];
        }
        case "LogicalExpression": {
          const isAnd = node.operator === "&&" || node.operator === "and";
          const right = {};
          const next: Block<T> = {};
          if (isAnd) {
            testStack.push({
              node: node.left,
              true: right,
              false: topTest.false || next,
            });
          } else {
            testStack.push({
              node: node.left,
              true: topTest.true || next,
              false: right,
            });
          }
          this.traverse(node.left);
          localState.unreachable = true;
          localState.newBlock(right);
          testStack.push({
            node: node.right,
            true: topTest.true || next,
            false: topTest.false || next,
          });
          this.traverse(node.right);
          localState.unreachable = true;
          if (next.preds) {
            localState.newBlock(next);
          }
          if (topTest.node === node) {
            testStack.pop();
          }
          return [];
        }

        case "VariableDeclarator":
          return ["init"];

        case "UnaryExpression":
          if (node.operator === ":") {
            return [];
          }
          break;
        case "UpdateExpression":
          // We don't want to traverse the argument, since then it would
          // look like a ref, rather than a def. But if its a
          // MemberExpression, we *do* want to traverse the sub-expressions
          // as potential refs.
          if (node.argument.type === "MemberExpression") {
            this.traverse(node.argument.object);
            if (node.argument.computed) {
              this.traverse(node.argument.property);
            }
          }
          return [];

        case "AssignmentExpression":
          if (refsForUpdate && node.operator !== "=") {
            // if its an update, we need to see a "ref"
            // of the lhs, then whatever happens on the rhs,
            // and then the assignment itself
            return null;
          }
          if (node.left.type === "MemberExpression") {
            this.traverse(node.left.object);
            if (node.left.computed) {
              this.traverse(node.left.property);
            }
          }
          return ["right"];

        case "ThrowStatement":
        case "ReturnStatement":
          if (node.argument) {
            this.traverse(node.argument);
          }
        // fall through
        case "BreakStatement":
        case "ContinueStatement":
          localState.terminal(node.type);
          return [];
        case "CallExpression":
          if (node.callee.type === "Identifier") {
            const extra = this.stack.splice(rootStack.length);
            this.traverse(node.callee);
            this.stack.push(...extra);
            return ["arguments"];
          }
          break;
      }
      return null;
    };
    const addEvent = (block: Block<T>, event: T) => {
      allEvents.push(event);
      if (!block.events) {
        block.events = [event];
      } else {
        block.events.push(event);
      }
    };
    state.post = function (node) {
      const eventIndex = eventsStack.pop()!;
      const getContainedEvents = () => allEvents.slice(eventIndex);
      const curStmt = stmtStack[stmtStack.length - 1];
      const topTest = testStack[testStack.length - 1];
      if (!this.inType) {
        const throws = tryActive > 0 && mayThrow(node);
        const events = notice(node, curStmt, throws, getContainedEvents);
        if (throws) {
          if (!events) {
            throw new Error(
              "mayThrow expression in try/catch must generate an event"
            );
          }
        } else {
          forEach(events, (e) => (e.mayThrow = false));
        }
        forEach(events, (event) => {
          if (event.mayThrow) {
            for (let i = localState.stack.length; i--; ) {
              const target = localState.stack[i].throw;
              if (target) {
                if (localState.curBlock.exsucc) {
                  if (localState.curBlock.exsucc !== target) {
                    throw new Error(`Block has multiple throw targets`);
                  }
                } else {
                  localState.curBlock.exsucc = target;
                  if (!target.expreds) {
                    target.expreds = [localState.curBlock];
                  } else {
                    target.expreds.push(localState.curBlock);
                  }
                }
                break;
              }
            }
          }
          addEvent(localState.curBlock, event);
        });
      }
      if (localState.top().node === node) {
        localState.pop();
      }
      if (topTest.node === node) {
        testStack.pop();
        if (topTest.true && !localState.unreachable) {
          localState.addEdge(localState.curBlock, topTest.true);
          if (topTest.false !== topTest.true) {
            if (localState.curBlock.succs?.length !== 1) {
              throw new Error("Internal error: Unexpected successor edges");
            }
            localState.addEdge(localState.curBlock, topTest.false);
            const event = notice(node, curStmt, 1, getContainedEvents);
            if (event) {
              if (Array.isArray(event)) {
                throw new Error(`Unexpected array of flw events`);
              }
              event.mayThrow = false;
              addEvent(localState.curBlock, event);
              localState.unreachable = true;
            }
          }
        }
      }
      if (curStmt === node) {
        stmtStack.pop();
      } else if (
        localState.unreachable &&
        curStmt.type === "BlockStatement" &&
        isStatement(node)
      ) {
        return false;
      }
      return null;
    };
    state.traverse(rootNode);
    return cleanCfg(ret);
  };

  try {
    if (root.nodes) {
      root.nodes.forEach((rootStack, rootNode) =>
        processOne(rootNode, rootStack)
      );
    } else {
      processOne(root.node!, root.stack!);
    }
    return ret;
  } finally {
    state.pre = pre;
    state.post = post;
    state.stack = stack;
  }
}

function cleanCfg<T extends EventConstraint<T>>(head: Block<T>) {
  preOrderTraverse(head, (cur: Block<T>) => {
    if (cur.succs && cur.succs.length === 1) {
      const succ = cur.succs[0];
      if (
        succ !== head &&
        succ.preds!.length === 1 &&
        (!cur.exsucc || cur.exsucc === succ.exsucc) &&
        (!succ.succs ||
          succ.succs.length === 1 ||
          (cur.preds && cur.preds.length === 1))
      ) {
        if (cur.events) {
          if (succ.events) {
            cur.events.push(...succ.events);
          }
        } else if (succ.events) {
          cur.events = succ.events;
        }
        if (succ.exsucc) {
          const preds = succ.exsucc.expreds!;
          for (let i = preds.length; i--; ) {
            if (preds[i] === succ) {
              // If cur has an exsucc, we already
              // checked that its the same as succ's,
              // so we can just delete the edge.
              // Otherwise, we need to point it at cur.
              if (cur.exsucc) {
                preds.splice(i, 1);
              } else {
                preds[i] = cur;
              }
            }
          }
        }
        cur.exsucc = succ.exsucc;
        cur.succs = succ.succs;
        if (cur.succs) {
          cur.succs.forEach((s) =>
            s.preds!.forEach((p, i, arr) => {
              if (p === succ) {
                arr[i] = cur;
              }
            })
          );
        }
        if (!cur.node) cur.node = succ.node;
      }
    }
  });
  return head;
}

export function postOrderTraverse<T extends EventConstraint<T>>(
  head: Block<T>,
  visitor: (block: Block<T>) => void
) {
  const visited = new Set<Block<T>>();
  const helper = (cur: Block<T>) => {
    if (visited.has(cur)) return;
    visited.add(cur);
    if (cur.succs) {
      cur.succs.forEach((block) => helper(block));
    }
    if (cur.exsucc) helper(cur.exsucc);
    visitor(cur);
  };
  helper(head);
}

export function preOrderTraverse<T extends EventConstraint<T>>(
  head: Block<T>,
  visitor: (block: Block<T>) => void
) {
  const visited = new Set<Block<T>>();
  const helper = (cur: Block<T>) => {
    if (visited.has(cur)) return;
    visited.add(cur);
    visitor(cur);
    if (cur.succs) {
      cur.succs.forEach((block) => helper(block));
    }
    if (cur.exsucc) helper(cur.exsucc);
  };
  helper(head);
}

export function getPostOrder<T extends EventConstraint<T>>(head: Block<T>) {
  const blocks: Block<T>[] = [];
  postOrderTraverse(head, (block) => blocks.push(block));
  return blocks;
}

export function getPreOrder<T extends EventConstraint<T>>(head: Block<T>) {
  const blocks: Block<T>[] = [];
  postOrderTraverse(head, (block) => blocks.push(block));
  return blocks;
}
