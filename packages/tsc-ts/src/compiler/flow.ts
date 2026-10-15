// The control flow graph the binder builds for narrowing and reachability.
//
// Each flow node points back to what runs before it: `antecedent` for most nodes,
// `antecedents` for labels, where paths join.
import type { ProgramLifetime } from '@scriptc/types';
import type { Node } from './ast.js';

export const enum FlowFlags {
  None = 0,
  Unreachable = 1 << 0,
  /** Start of a function, source file or other control flow container. */
  Start = 1 << 1,
  /** A junction of paths, e.g. after an `if`. */
  BranchLabel = 1 << 2,
  /** The top of a loop. */
  LoopLabel = 1 << 3,
  Assignment = 1 << 4,
  /** `node` is known to be true here. */
  TrueCondition = 1 << 5,
  /** `node` is known to be false here. */
  FalseCondition = 1 << 6,
  /** The start of a range of `case` clauses. */
  SwitchClause = 1 << 7,
  /** A possible array mutation such as `x.push(…)` or `x[i] = …`. */
  ArrayMutation = 1 << 8,
  /** A call that may be an assertion. */
  Call = 1 << 9,
  /** Temporarily narrows a label's antecedents; see `FlowReduceLabel`. */
  ReduceLabel = 1 << 10,
  /** Referenced as an antecedent once. */
  Referenced = 1 << 11,
  /** Referenced as an antecedent more than once. */
  Shared = 1 << 12,

  Label = BranchLabel | LoopLabel,
  Condition = TrueCondition | FalseCondition,
}

export class FlowNode implements ProgramLifetime {
  flags: FlowFlags;
  /** The assignment, condition, call or function this node is about. */
  node: Node | undefined;
  /** What runs before this node, for all but labels. */
  antecedent: FlowNode | undefined;
  /** For labels: the joined paths, in order of addition. */
  antecedents: FlowNode[] | undefined;

  constructor(flags: FlowFlags, node: Node | undefined, antecedent: FlowNode | undefined) {
    this.flags = flags;
    this.node = node;
    this.antecedent = antecedent;
    this.antecedents = undefined;
  }
}

/**
 * Entry to clauses `clauseStart` to `clauseEnd` (exclusive) of `switchStatement`, which is
 * also `node`. An empty range means no clause matched.
 */
export class FlowSwitchClause extends FlowNode {
  readonly switchStatement: Node;
  readonly clauseStart: number;
  readonly clauseEnd: number;

  constructor(antecedent: FlowNode, switchStatement: Node, clauseStart: number, clauseEnd: number) {
    super(FlowFlags.SwitchClause, switchStatement, antecedent);
    this.switchStatement = switchStatement;
    this.clauseStart = clauseStart;
    this.clauseEnd = clauseEnd;
  }

  isEmpty(): boolean {
    return this.clauseStart === this.clauseEnd;
  }
}

/**
 * While analysis passes this node, `target` (the label before a `finally` block) has only
 * `antecedents`, e.g. the paths that completed the `try` block normally.
 */
export class FlowReduceLabel extends FlowNode {
  readonly target: FlowNode;

  constructor(target: FlowNode, antecedents: FlowNode[], antecedent: FlowNode) {
    super(FlowFlags.ReduceLabel, undefined, antecedent);
    this.target = target;
    this.antecedents = antecedents;
  }
}
