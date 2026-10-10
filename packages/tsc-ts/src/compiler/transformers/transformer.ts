// The base of every transform: a visitor over one source file at a time.
import { ModifierList, type Node, SourceFile } from '../ast.js';
import type { ModifierFlags } from '../ast.js';
import { modifierToFlag } from '../ast-utilities.js';
import type { EmitContext } from '../printer/emit-context.js';
import { NotEmittedStatement } from '../ast.js';
import { VisitorBase } from './visitor-base.js';

export abstract class Transformer extends VisitorBase {
  /** What this transform couldn't handle in the last file, or `''`. */
  unsupported: string;

  constructor(context: EmitContext) {
    super(context);
    this.unsupported = '';
  }

  /** Records syntax this transform doesn't implement yet; emit of the file is skipped. */
  unsupportedNode(node: Node, what: string): Node {
    if (this.unsupported === '') this.unsupported = what + ' are not supported yet';
    return node;
  }

  transformSourceFile(file: SourceFile): SourceFile {
    const visited = this.visitNode(file);
    if (visited instanceof SourceFile) return visited;
    throw new Error('A transform must return a source file');
  }

  /** A statement that prints nothing but keeps the comments of `node`. */
  notEmitted(node: Node): NotEmittedStatement {
    const statement = this.factory.created(new NotEmittedStatement());
    statement.pos = node.pos;
    statement.end = node.end;
    this.context.setOriginal(statement, node);
    this.context.assignCommentRange(statement, node);
    return statement;
  }

  /** The modifiers of `modifiers` whose flags are in `allowed`. */
  extractModifiers(modifiers: ModifierList | undefined, allowed: ModifierFlags): ModifierList | undefined {
    if (modifiers === undefined) return undefined;
    const nodes = modifiers.nodes;
    let kept: Node[] | undefined = undefined;
    for (let i = 0; i < nodes.length; i++) {
      const keep = (modifierToFlag(nodes[i].kind) & allowed) !== 0;
      if (keep && kept !== undefined) kept.push(nodes[i]);
      else if (!keep && kept === undefined) kept = nodes.slice(0, i);
    }
    if (kept === undefined) return modifiers;
    const list = this.factory.createModifierList(kept);
    list.pos = modifiers.pos;
    list.end = modifiers.end;
    return list;
  }
}
