// Lowers `a ||= b`, `a &&= b` and `a ??= b` to `a || (a = b)` and so on (ES2021).
import { BinaryExpression, ElementAccessExpression, type Node, PropertyAccessExpression } from '../ast.js';
import { skipParentheses } from '../binder-utilities.js';
import type { EmitContext } from '../printer/emit-context.js';
import { SyntaxKind } from '../syntax-kind.js';
import { isSimpleCopiableExpression } from './destructuring.js';
import { SubtreeFacts, type SyntaxFacts } from './syntax-facts.js';
import { Transformer } from './transformer.js';

export class LogicalAssignmentTransformer extends Transformer {
  readonly facts: SyntaxFacts;

  constructor(context: EmitContext, facts: SyntaxFacts) {
    super(context);
    this.facts = facts;
  }

  visit(node: Node): Node | undefined {
    if (!this.facts.has(node, SubtreeFacts.ContainsLogicalAssignments)) return node;
    if (node instanceof BinaryExpression) {
      const operator = logicalOperatorOf(node.operatorToken.kind);
      if (operator !== SyntaxKind.Unknown) return this.visitLogicalAssignment(node, operator);
    }
    return this.visitEachChild(node);
  }

  private visitLogicalAssignment(node: BinaryExpression, operator: SyntaxKind): Node {
    const factory = this.factory;
    const visited = skipParentheses(this.visitNode(node.left)!);
    let left = visited;
    let target = visited;
    const right = skipParentheses(this.visitNode(node.right)!);
    if (visited instanceof PropertyAccessExpression) {
      const object = this.copiableObject(visited.expression);
      target = factory.createPropertyAccessExpression(object, visited.name);
      left = factory.createPropertyAccessExpression(this.assignedObject(object, visited.expression), visited.name);
    } else if (visited instanceof ElementAccessExpression) {
      const object = this.copiableObject(visited.expression);
      const argument = this.copiableObject(visited.argumentExpression);
      target = factory.createElementAccessExpression(object, argument);
      left = factory.createElementAccessExpression(
        this.assignedObject(object, visited.expression),
        this.assignedObject(argument, visited.argumentExpression),
      );
    }
    return factory.createBinaryExpression(
      left,
      operator,
      factory.createParenthesizedExpression(factory.createAssignment(target, right)),
    );
  }

  /** `expression`, or a temporary to hold it when it can't be evaluated twice. */
  private copiableObject(expression: Node): Node {
    if (isSimpleCopiableExpression(expression)) return expression;
    return this.context.addVariableDeclaration(this.factory.createTempVariable(0));
  }

  /** `expression`, or its assignment to the temporary `copy` holding it. */
  private assignedObject(copy: Node, expression: Node): Node {
    return copy === expression ? expression : this.factory.createAssignment(copy, expression);
  }
}

function logicalOperatorOf(kind: SyntaxKind): SyntaxKind {
  switch (kind) {
    case SyntaxKind.BarBarEqualsToken:
      return SyntaxKind.BarBarToken;
    case SyntaxKind.AmpersandAmpersandEqualsToken:
      return SyntaxKind.AmpersandAmpersandToken;
    case SyntaxKind.QuestionQuestionEqualsToken:
      return SyntaxKind.QuestionQuestionToken;
  }
  return SyntaxKind.Unknown;
}
