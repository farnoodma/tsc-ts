// Tokens the parser doesn't store, found by scanning between child nodes.
import { type Node, NodeFlags, type NodeList, NodeVisitor, type SourceFile, Token } from '../compiler/ast.js';
import { getJSDoc } from '../compiler/parser.js';
import { Scanner } from '../compiler/scanner.js';
import { type SyntaxKind } from '../compiler/syntax-kind.js';

class ChildCollector extends NodeVisitor {
  readonly children: Node[] = [];

  visitNode(node: Node): boolean {
    if ((node.flags & NodeFlags.Reparsed) === 0) this.children.push(node);
    return false;
  }

  visitList(list: NodeList): boolean {
    for (const node of list.nodes) this.visitNode(node);
    return false;
  }
}

/** The child node or token of `kind` in `node`, scanning the text between children. */
export function findChildTokenOfKind(node: Node, kind: SyntaxKind, file: SourceFile): Node | undefined {
  const collector = new ChildCollector();
  for (const jsDoc of getJSDoc(file, node)) collector.visitNode(jsDoc);
  node.forEachChild(collector);
  const scanner = new Scanner();
  scanner.setText(file.text);
  scanner.setLanguageVariant(file.languageVariant);
  let last = node.pos;
  const tokenIn = (end: number): Node | undefined => {
    scanner.resetTokenState(last);
    scanner.scan();
    while (scanner.getTokenFullStart() < end && scanner.getTokenEnd() <= end) {
      if (scanner.getToken() === kind) {
        const token = new Token(kind);
        token.pos = scanner.getTokenFullStart() | 0;
        token.end = scanner.getTokenEnd() | 0;
        token.parent = node;
        return token;
      }
      if (scanner.getTokenEnd() >= end) break;
      scanner.scan();
    }
    return undefined;
  };
  for (const child of collector.children) {
    if (last < child.pos) {
      const token = tokenIn(child.pos);
      if (token !== undefined) return token;
    }
    if (child.kind === kind) return child;
    last = child.end;
  }
  return last < node.end ? tokenIn(node.end) : undefined;
}
