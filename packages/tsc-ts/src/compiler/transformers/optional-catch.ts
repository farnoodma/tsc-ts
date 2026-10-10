// Gives `catch` clauses without a binding a temporary one (ES2019).
import { Block, CatchClause, type Node } from '../ast.js';
import type { EmitContext } from '../printer/emit-context.js';
import { SubtreeFacts, type SyntaxFacts } from './syntax-facts.js';
import { Transformer } from './transformer.js';

export class OptionalCatchTransformer extends Transformer {
  readonly facts: SyntaxFacts;

  constructor(context: EmitContext, facts: SyntaxFacts) {
    super(context);
    this.facts = facts;
  }

  visit(node: Node): Node | undefined {
    if (!this.facts.has(node, SubtreeFacts.ContainsMissingCatchClauseVariable)) return node;
    if (node instanceof CatchClause && node.variableDeclaration === undefined) {
      const factory = this.factory;
      const block = this.visitNode(node.block);
      return factory.created(
        new CatchClause(
          factory.createVariableDeclaration(factory.createTempVariable(0), undefined, undefined, undefined),
          block instanceof Block ? block : node.block,
        ),
      );
    }
    return this.visitEachChild(node);
  }
}
