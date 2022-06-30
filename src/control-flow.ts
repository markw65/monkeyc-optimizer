import { mctree } from "@markw65/prettier-plugin-monkeyc";
import { isExpression, isStatement, mayThrow } from "./ast";
import { pushUnique } from "./util";

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
};

type LocalAttributeStack<T extends EventConstraint<T>> = LocalInfo<T>[];

export type Block<T extends EventConstraint<T>> = {
  node?: mctree.Node;
  preds?: Block<T>[];
  succs?: Block<T>[];
  expreds?: Block<T>[];
  exsucc?: Block<T>;
  events?: T[];
};

class LocalState<T extends EventConstraint<T>> {
  stack: LocalAttributeStack<T> = [];
  info = new Map<mctree.Node, LocalInfo<T>>();
  curBlock: Block<T> = {};
  unreachable = false;

  constructor(func: mctree.FunctionDeclaration) {
    this.push(func);
  }

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
    if (re) {
      for (let i = this.stack.length; i--; ) {
        const target = this.stack[i][re];
        if (target) {
          this.addEdge(this.curBlock, target);
          break;
        }
      }
    }
    this.unreachable = true;
  }
}

export function buildReducedGraph<T extends EventConstraint<T>>(
  state: ProgramStateAnalysis,
  func: FunctionStateNode,
  notice: (node: mctree.Node, stmt: mctree.Node, mayThrow: boolean) => T | null
) {
  const { stack, pre, post } = state;
  try {
    const localState = new LocalState<T>(func.node);
    const ret = localState.curBlock;
    state.stack = func.stack!;
    const stmtStack: mctree.Node[] = [func.node];
    let tryActive = 0;
    state.pre = (node) => {
      if (state.inType || localState.unreachable) {
        return [];
      }
      if (
        !localState.curBlock.node &&
        (isStatement(node) || isExpression(node))
      ) {
        localState.curBlock.node = node;
      }
      if (isStatement(node)) {
        stmtStack.push(node);
      }
      switch (node.type) {
        case "AttributeList":
          return [];
        case "SwitchStatement": {
          const top = localState.push(node);
          top.break = {};
          state.traverse(node.discriminant);
          const testBlocks: Block<T>[] = [];
          let defaultSeen = false;
          node.cases.forEach((sc, i) => {
            if (sc.test) {
              state.traverse(sc.test);
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
              state.traverse(s);
              return !localState.unreachable;
            });
          });
          localState.newBlock(top.break);
          localState.unreachable = !top.break.preds;
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
            state.traverse(node.test);
            localState.addEdge(localState.newBlock(), top.break);
          } else {
            head = localState.newBlock();
          }
          state.traverse(node.body);
          if (node.type === "DoWhileStatement") {
            localState.newBlock(top.continue);
            state.traverse(node.test);
            localState.addEdge(localState.curBlock, top.break);
          }
          localState.addEdge(localState.curBlock, head);
          localState.curBlock = top.break;
          return [];
        }
        case "TryStatement": {
          const top = localState.push(node);
          const catches = (top.throw = {});
          // This edge shouldn't exist, but we can trigger
          // (incorrect) "variable may not be initialized" errors
          // in the monkey c compiler without it.
          // https://forums.garmin.com/developer/connect-iq/i/bug-reports/incorrect-maybe-uninitialized-error
          localState.addEdge(localState.curBlock, top.throw);
          localState.newBlock();
          tryActive++;
          state.traverse(node.block);
          tryActive--;
          delete top.throw;
          top.posttry = {};
          const tryFallsThrough = !localState.unreachable;
          if (node.finalizer) {
            tryActive++;
            top.throw = top.finally = {};
            // curBlock branches to finally, no matter how it exits.
            localState.addEdge(localState.curBlock, top.finally);
          } else {
            if (!localState.unreachable) {
              localState.addEdge(localState.curBlock, top.posttry);
            }
          }
          localState.unreachable = true;
          localState.newBlock(catches);
          if (node.handler) {
            state.traverse(node.handler);
            if (top.throw) {
              tryActive--;
              delete top.throw;
            }
            // Each "catch (ex instanceof Foo)" chains to the next,
            // but "catch (ex)" terminates the list. If the end
            // of the chain has a predecessor, its possible that
            // none of the conditions matched, so the exception
            // will propagate from there.
            if (localState.curBlock.preds) {
              localState.terminal("ThrowStatement");
            }
          }
          if (top.throw) {
            tryActive--;
            delete top.throw;
          }
          if (node.finalizer) {
            localState.unreachable = true;
            localState.newBlock(top.finally);
            delete top.finally;
            state.traverse(node.finalizer);
            if (tryFallsThrough && !localState.unreachable) {
              localState.addEdge(localState.curBlock, top.posttry);
            }
            localState.terminal("ThrowStatement");
          }
          localState.unreachable = true;
          localState.newBlock(top.posttry);
          return [];
        }
        case "CatchClause": {
          const top = localState.top();
          if (!localState.curBlock.preds && !localState.curBlock.expreds) {
            return [];
          }
          const next = {};
          if (node.param && node.param.type === "BinaryExpression") {
            state.traverse(node.param);
            localState.addEdge(localState.curBlock, next);
            localState.newBlock();
          }
          state.traverse(node.body);

          if (top.finally) {
            // this edge exists even if this point is unreachable
            localState.addEdge(localState.curBlock, top.finally);
          }
          if (!localState.unreachable) {
            if (!top.posttry) top.posttry = {};
            localState.addEdge(localState.curBlock, top.posttry);
          }
          localState.unreachable = true;
          localState.newBlock(next);
          return [];
        }
        case "ForStatement": {
          const top = localState.push(node);
          if (node.init) state.traverse(node.init);
          const head = localState.newBlock();
          top.break = {};
          top.continue = {};
          if (node.test) {
            state.traverse(node.test);
            localState.addEdge(localState.curBlock, top.break);
            localState.newBlock();
          }
          state.traverse(node.body);
          localState.newBlock(top.continue);
          if (node.update) {
            state.traverse(node.update);
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
          state.traverse(node.test);
          const alternate = {};
          localState.addEdge(localState.curBlock, alternate);
          localState.newBlock();
          state.traverse(node.consequent);
          const consequent = localState.unreachable
            ? null
            : localState.curBlock;
          localState.unreachable = true;
          localState.newBlock(alternate);
          if (node.alternate) {
            state.traverse(node.alternate);
            if (!localState.unreachable) {
              localState.newBlock();
            }
          }
          if (consequent) {
            if (localState.unreachable) {
              localState.newBlock();
            }
            localState.addEdge(consequent, localState.curBlock);
          }
          return [];
        }
        case "LogicalExpression": {
          state.traverse(node.left);
          if (localState.unreachable) break;
          const mid = localState.curBlock;
          localState.newBlock();
          state.traverse(node.right);
          localState.newBlock();
          localState.addEdge(mid, localState.curBlock);
          return [];
        }

        case "VariableDeclarator":
          return ["init"];

        case "MemberExpression":
          if (!node.computed) {
            return ["object"];
          }
          break;

        case "UnaryExpression":
          if (node.operator === ":") {
            return [];
          }
          break;
        case "UpdateExpression":
          // We don't want to traverse the argument, since then it would
          // look like a ref, rather than a def. But if its a
          // MemberExpression, we *do* want to traverse the subexpressions
          // as potential refs.
          if (node.argument.type === "MemberExpression") {
            state.traverse(node.argument.object);
            if (node.argument.computed) {
              state.traverse(node.argument.property);
            }
          }
          return [];

        case "AssignmentExpression":
          if (node.left.type === "MemberExpression") {
            state.traverse(node.left.object);
            if (node.left.computed) {
              state.traverse(node.left.property);
            }
          }
          return ["right"];

        case "ThrowStatement":
        case "ReturnStatement":
          if (node.argument) {
            state.traverse(node.argument);
          }
        // fall through
        case "BreakStatement":
        case "ContinueStatement":
          localState.terminal(node.type);
          return [];
      }
      return null;
    };
    const addEvent = (block: Block<T>, event: T) => {
      if (!block.events) {
        block.events = [event];
      } else {
        block.events.push(event);
      }
    };
    state.post = (node) => {
      const curStmt = stmtStack[stmtStack.length - 1];
      if (!state.inType) {
        const throws = tryActive > 0 && mayThrow(node);
        const event = notice(node, curStmt, throws);
        if (throws) {
          if (!event) {
            throw new Error(
              "mayThrow expression in try/catch must generate an event"
            );
          }
        } else if (event) {
          event.mayThrow = false;
        }
        if (event) {
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
        }
      }
      if (curStmt === node) {
        stmtStack.pop();
      }
      if (localState.top().node === node) {
        localState.pop();
      }
      return null;
    };
    state.traverse(func.node);
    return cleanCfg(ret);
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
