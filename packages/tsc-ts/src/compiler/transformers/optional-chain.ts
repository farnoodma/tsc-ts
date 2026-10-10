// Lowers optional chains such as `a?.b.c()` to conditionals on `null` and `undefined` (ES2020).
import {
  CallExpression,
  DeleteExpression,
  ElementAccessExpression,
  type Node,
  NodeFlags,
  ParenthesizedExpression,
  PropertyAccessExpression,
  SyntheticReferenceExpression,
  TaggedTemplateExpression,
} from '../ast.js';
import { skipParentheses } from '../binder-utilities.js';
import type { EmitContext } from '../printer/emit-context.js';
import { EmitFlags } from '../printer/emit-flags.js';
import { skipPartiallyEmittedExpressions } from '../printer/utilities.js';
import { SyntaxKind } from '../syntax-kind.js';
import { isSimpleCopiableExpression } from './destructuring.js';
import { SubtreeFacts, type SyntaxFacts } from './syntax-facts.js';
import { Transformer } from './transformer.js';
import { OuterExpressionKinds } from './utilities.js';

export class OptionalChainTransformer extends Transformer {
  readonly facts: SyntaxFacts;

  constructor(context: EmitContext, facts: SyntaxFacts) {
    super(context);
    this.facts = facts;
  }

  visit(node: Node): Node | undefined {
    if (!this.facts.has(node, SubtreeFacts.ContainsOptionalChaining)) return node;
    switch (node.kind) {
      case SyntaxKind.CallExpression:
        return this.visitCallExpression(node as CallExpression, false);
      case SyntaxKind.PropertyAccessExpression:
      case SyntaxKind.ElementAccessExpression:
        if ((node.flags & NodeFlags.OptionalChain) !== 0) return this.visitOptionalExpression(node, false, false);
        break;
      case SyntaxKind.DeleteExpression:
        if (
          node instanceof DeleteExpression &&
          (skipParentheses(node.expression).flags & NodeFlags.OptionalChain) !== 0
        )
          return this.visitNonOptionalExpression(node.expression, false, true);
        break;
    }
    return this.visitEachChild(node);
  }

  private visitCallExpression(node: CallExpression, captureThisArg: boolean): Node {
    // An optional call chain is the outermost link of an optional expression.
    if ((node.flags & NodeFlags.OptionalChain) !== 0) return this.visitOptionalExpression(node, captureThisArg, false);
    const callee = node.expression;
    if (callee instanceof ParenthesizedExpression && (skipParentheses(callee).flags & NodeFlags.OptionalChain) !== 0) {
      // `(a?.b)()` calls with `a` as this.
      const expression = this.visitParenthesizedExpression(callee, true, false);
      const args = this.visitNodes(node.arguments)!;
      if (expression instanceof SyntheticReferenceExpression) {
        const call = this.factory.createFunctionCallCall(expression.expression, expression.thisArg, args.nodes);
        call.pos = node.pos;
        call.end = node.end;
        this.context.setOriginal(call, node);
        return call;
      }
      return this.factory.updateCallExpression(node, expression, undefined, undefined, args, node.flags);
    }
    return this.visitEachChild(node);
  }

  private visitParenthesizedExpression(
    node: ParenthesizedExpression,
    captureThisArg: boolean,
    isDelete: boolean,
  ): Node {
    const expression = this.visitNonOptionalExpression(node.expression, captureThisArg, isDelete);
    if (expression instanceof SyntheticReferenceExpression) {
      // `(a.b)` -> `((_a = a).b)` with this `_a`
      const reference = this.factory.createSyntheticReferenceExpression(
        this.factory.updateParenthesizedExpression(node, expression.expression),
        expression.thisArg,
      );
      this.context.setOriginal(reference, node);
      return reference;
    }
    return this.factory.updateParenthesizedExpression(node, expression);
  }

  private visitPropertyOrElementAccessExpression(node: Node, captureThisArg: boolean, isDelete: boolean): Node {
    if ((node.flags & NodeFlags.OptionalChain) !== 0)
      return this.visitOptionalExpression(node, captureThisArg, isDelete);
    const factory = this.factory;
    let expression = this.visitNode(accessedExpression(node))!;
    let thisArg: Node | undefined = undefined;
    if (captureThisArg) {
      if (isSimpleCopiableExpression(expression)) thisArg = expression;
      else {
        thisArg = this.context.addVariableDeclaration(factory.createTempVariable(0));
        expression = factory.createAssignment(thisArg, expression);
      }
    }
    if (node instanceof PropertyAccessExpression)
      expression = factory.updatePropertyAccessExpression(
        node,
        expression,
        undefined,
        this.visitNode(node.name)!,
        node.flags,
      );
    else if (node instanceof ElementAccessExpression)
      expression = factory.updateElementAccessExpression(
        node,
        expression,
        undefined,
        this.visitNode(node.argumentExpression)!,
        node.flags,
      );
    if (thisArg === undefined) return expression;
    const reference = factory.createSyntheticReferenceExpression(expression, thisArg);
    this.context.setOriginal(reference, node);
    return reference;
  }

  private visitNonOptionalExpression(node: Node, captureThisArg: boolean, isDelete: boolean): Node {
    switch (node.kind) {
      case SyntaxKind.ParenthesizedExpression:
        return this.visitParenthesizedExpression(node as ParenthesizedExpression, captureThisArg, isDelete);
      case SyntaxKind.ElementAccessExpression:
      case SyntaxKind.PropertyAccessExpression:
        return this.visitPropertyOrElementAccessExpression(node, captureThisArg, isDelete);
      case SyntaxKind.CallExpression:
        return this.visitCallExpression(node as CallExpression, captureThisArg);
    }
    return this.visitNode(node)!;
  }

  private visitOptionalExpression(node: Node, captureThisArg: boolean, isDelete: boolean): Node {
    const factory = this.factory;
    const context = this.context;
    // The links of the chain, from the one with `?.` outwards, and the expression they start from.
    const chain: Node[] = [node];
    let link = node;
    while (!(link instanceof TaggedTemplateExpression) && questionDotTokenOf(link) === undefined) {
      link = skipPartiallyEmittedExpressions(accessedExpression(link));
      chain.unshift(link);
    }
    const expression = accessedExpression(link);
    const left = this.visitNonOptionalExpression(
      skipPartiallyEmittedExpressions(expression),
      chain[0].kind === SyntaxKind.CallExpression && (chain[0].flags & NodeFlags.OptionalChain) !== 0,
      false,
    );
    let leftThisArg: Node | undefined = undefined;
    let capturedLeft = left;
    if (left instanceof SyntheticReferenceExpression) {
      leftThisArg = left.thisArg;
      capturedLeft = left.expression;
    }
    let leftExpression = factory.restoreOuterExpressions(
      expression,
      capturedLeft,
      OuterExpressionKinds.PartiallyEmittedExpressions,
    );
    if (!isSimpleCopiableExpression(capturedLeft)) {
      capturedLeft = context.addVariableDeclaration(factory.createTempVariable(0));
      leftExpression = factory.createAssignment(capturedLeft, leftExpression);
    }
    let rightExpression = capturedLeft;
    let thisArg: Node | undefined = undefined;
    for (let i = 0; i < chain.length; i++) {
      const segment = chain[i];
      const access =
        segment.kind === SyntaxKind.PropertyAccessExpression || segment.kind === SyntaxKind.ElementAccessExpression;
      if (access) {
        if (i === chain.length - 1 && captureThisArg) {
          if (isSimpleCopiableExpression(rightExpression)) thisArg = rightExpression;
          else {
            thisArg = context.addVariableDeclaration(factory.createTempVariable(0));
            rightExpression = factory.createAssignment(thisArg, rightExpression);
          }
        }
        if (segment instanceof ElementAccessExpression)
          rightExpression = factory.createElementAccessExpression(
            rightExpression,
            this.visitNode(segment.argumentExpression)!,
          );
        else if (segment instanceof PropertyAccessExpression)
          rightExpression = factory.createPropertyAccessExpression(rightExpression, this.visitNode(segment.name)!);
      } else if (segment instanceof CallExpression) {
        if (i === 0 && leftThisArg !== undefined) {
          if (!context.hasAutoGenerateInfo(leftThisArg)) {
            leftThisArg = factory.cloneNode(leftThisArg, leftThisArg.deepClone());
            context.addEmitFlags(leftThisArg, EmitFlags.NoComments);
          }
          const callThisArg =
            leftThisArg.kind === SyntaxKind.SuperKeyword ? factory.createThisExpression() : leftThisArg;
          rightExpression = factory.createFunctionCallCall(
            rightExpression,
            callThisArg,
            this.visitNodes(segment.arguments)!.nodes,
          );
        } else
          rightExpression = factory.created(
            new CallExpression(
              rightExpression,
              undefined,
              undefined,
              this.visitNodes(segment.arguments)!,
              NodeFlags.None,
            ),
          );
      }
      context.setOriginal(rightExpression, segment);
    }
    const condition = factory.createNotNullCondition(leftExpression, capturedLeft, true);
    let target: Node = isDelete
      ? factory.createConditionalExpression(
          condition,
          factory.createTrue(),
          factory.createDeleteExpression(rightExpression),
        )
      : factory.createConditionalExpression(condition, factory.createVoidZero(), rightExpression);
    target.pos = node.pos;
    target.end = node.end;
    if (thisArg !== undefined) target = factory.createSyntheticReferenceExpression(target, thisArg);
    context.setOriginal(target, node);
    return target;
  }
}

function questionDotTokenOf(node: Node): Node | undefined {
  if (node instanceof PropertyAccessExpression) return node.questionDotToken;
  if (node instanceof ElementAccessExpression) return node.questionDotToken;
  if (node instanceof CallExpression) return node.questionDotToken;
  return undefined;
}

/** The expression a link of a chain accesses or calls. */
function accessedExpression(node: Node): Node {
  if (node instanceof PropertyAccessExpression) return node.expression;
  if (node instanceof ElementAccessExpression) return node.expression;
  if (node instanceof CallExpression) return node.expression;
  if (node instanceof TaggedTemplateExpression) return node.tag;
  if (node instanceof ParenthesizedExpression) return node.expression;
  return node;
}
