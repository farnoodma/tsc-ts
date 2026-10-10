// Lowers `**` and `**=` to `Math.pow` (ES2016).
import { BinaryExpression, ElementAccessExpression, type Node, PropertyAccessExpression } from '../ast.js';
import type { EmitContext } from '../printer/emit-context.js';
import { SyntaxKind } from '../syntax-kind.js';
import { SubtreeFacts, type SyntaxFacts } from './syntax-facts.js';
import { Transformer } from './transformer.js';

export class ExponentiationTransformer extends Transformer {
  readonly facts: SyntaxFacts;

  constructor(context: EmitContext, facts: SyntaxFacts) {
    super(context);
    this.facts = facts;
  }

  visit(node: Node): Node | undefined {
    if (!this.facts.has(node, SubtreeFacts.ContainsExponentiationOperator)) return node;
    if (node instanceof BinaryExpression) {
      const operator = node.operatorToken.kind;
      if (operator === SyntaxKind.AsteriskAsteriskEqualsToken) return this.visitAssignment(node);
      if (operator === SyntaxKind.AsteriskAsteriskToken) {
        const left = this.visitNode(node.left)!;
        const right = this.visitNode(node.right)!;
        return this.pow(left, right, node);
      }
    }
    return this.visitEachChild(node);
  }

  private pow(value: Node, exponent: Node, node: Node): Node {
    const call = this.factory.createGlobalMethodCall('Math', 'pow', [value, exponent]);
    call.pos = node.pos;
    call.end = node.end;
    return call;
  }

  private visitAssignment(node: BinaryExpression): Node {
    const factory = this.factory;
    const context = this.context;
    const left = this.visitNode(node.left)!;
    const right = this.visitNode(node.right)!;
    let target: Node;
    let value: Node;
    if (left instanceof ElementAccessExpression) {
      // `a[x] **= b` -> `(_a = a)[_x = x] = Math.pow(_a[_x], b)`
      const object = context.addVariableDeclaration(factory.createTempVariable(0));
      const argument = context.addVariableDeclaration(factory.createTempVariable(0));
      const objectAssignment = factory.createAssignment(object, left.expression);
      objectAssignment.pos = left.expression.pos;
      objectAssignment.end = left.expression.end;
      const argumentAssignment = factory.createAssignment(argument, left.argumentExpression);
      argumentAssignment.pos = left.argumentExpression.pos;
      argumentAssignment.end = left.argumentExpression.end;
      target = factory.createElementAccessExpression(objectAssignment, argumentAssignment);
      value = factory.createElementAccessExpression(object, argument);
      value.pos = left.pos;
      value.end = left.end;
    } else if (left instanceof PropertyAccessExpression) {
      // `a.x **= b` -> `(_a = a).x = Math.pow(_a.x, b)`
      const object = context.addVariableDeclaration(factory.createTempVariable(0));
      const assignment = factory.createAssignment(object, left.expression);
      assignment.pos = left.expression.pos;
      assignment.end = left.expression.end;
      target = factory.createPropertyAccessExpression(assignment, left.name);
      target.pos = left.pos;
      target.end = left.end;
      value = factory.createPropertyAccessExpression(object, left.name);
      value.pos = left.pos;
      value.end = left.end;
    } else {
      // `a **= b` -> `a = Math.pow(a, b)`
      target = left;
      value = left;
    }
    const result = factory.createAssignment(target, this.pow(value, right, node));
    result.pos = node.pos;
    result.end = node.end;
    return result;
  }
}
