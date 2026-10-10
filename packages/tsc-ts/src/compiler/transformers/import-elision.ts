// Removes imports used only as types, and exports of types.
import {
  ExportAssignment,
  ExportDeclaration,
  ImportAttributes,
  ImportClause,
  ImportDeclaration,
  ImportEqualsDeclaration,
  NamedExports,
  NamedImports,
  type Node,
  NodeFlags,
  SourceFile,
} from '../ast.js';
import type { CompilerOptions } from '../options.js';
import type { EmitContext } from '../printer/emit-context.js';
import { SyntaxKind } from '../syntax-kind.js';
import type { EmitResolver } from './emit-resolver.js';
import { Transformer } from './transformer.js';
import { isExternalModule } from './utilities.js';

export class ImportElision extends Transformer {
  readonly options: CompilerOptions;
  readonly resolver: EmitResolver;
  private currentSourceFile: SourceFile | undefined;

  constructor(context: EmitContext, options: CompilerOptions, resolver: EmitResolver) {
    super(context);
    this.options = options;
    this.resolver = resolver;
    this.currentSourceFile = undefined;
  }

  visit(node: Node): Node | undefined {
    const factory = this.factory;
    switch (node.kind) {
      case SyntaxKind.SourceFile:
        if (node instanceof SourceFile) {
          const original = this.context.mostOriginal(node);
          if (original instanceof SourceFile) this.resolver.markLinkedReferences(original);
          const saved = this.currentSourceFile;
          this.currentSourceFile = node;
          const result = this.visitEachChild(node);
          this.currentSourceFile = saved;
          return result;
        }
        break;
      case SyntaxKind.ImportEqualsDeclaration:
        if (node instanceof ImportEqualsDeclaration) {
          const keep =
            node.moduleReference.kind === SyntaxKind.ExternalModuleReference
              ? this.shouldEmitAliasDeclaration(node)
              : this.shouldEmitAliasDeclaration(node) ||
                (this.currentSourceFile !== undefined &&
                  !isExternalModule(this.currentSourceFile) &&
                  this.isTopLevelValueImportEqualsWithEntityName(node));
          return keep ? this.visitEachChild(node) : undefined;
        }
        break;
      case SyntaxKind.ImportDeclaration:
        if (node instanceof ImportDeclaration) {
          if (node.importClause === undefined) return this.visitEachChild(node);
          const clause = this.visitNode(node.importClause);
          if (!(clause instanceof ImportClause)) return undefined;
          const importClause = clause;
          return factory.updateImportDeclaration(
            node,
            node.modifiers,
            importClause,
            node.moduleSpecifier,
            this.importAttributes(node.attributes),
          );
        }
        break;
      case SyntaxKind.ImportClause:
        if (node instanceof ImportClause) {
          const name = this.shouldEmitAliasDeclaration(node) ? node.name : undefined;
          const bindings = this.visitNode(node.namedBindings);
          if (name === undefined && bindings === undefined) return undefined;
          return factory.updateImportClause(node, node.phaseModifier, name, bindings);
        }
        break;
      case SyntaxKind.NamespaceImport:
      case SyntaxKind.ImportSpecifier:
        return this.shouldEmitAliasDeclaration(node) ? node : undefined;
      case SyntaxKind.NamedImports:
        if (node instanceof NamedImports) {
          const elements = this.visitNodes(node.elements)!;
          return elements.nodes.length === 0 ? undefined : factory.updateNamedImports(node, elements);
        }
        break;
      case SyntaxKind.ExportAssignment:
        if (node instanceof ExportAssignment) {
          if (this.options.verbatimModuleSyntax !== true && !this.isValueAliasDeclaration(node)) return undefined;
          return this.visitEachChild(node);
        }
        break;
      case SyntaxKind.ExportDeclaration:
        if (node instanceof ExportDeclaration) {
          let clause: Node | undefined = undefined;
          if (node.exportClause !== undefined) {
            clause = this.visitNode(node.exportClause);
            if (clause === undefined) return undefined;
          }
          return factory.updateExportDeclaration(
            node,
            undefined,
            false,
            clause,
            this.visitNode(node.moduleSpecifier),
            this.importAttributes(node.attributes),
          );
        }
        break;
      case SyntaxKind.NamedExports:
        if (node instanceof NamedExports) {
          const elements = this.visitNodes(node.elements)!;
          return elements.nodes.length === 0 ? undefined : factory.updateNamedExports(node, elements);
        }
        break;
      case SyntaxKind.ExportSpecifier:
        return this.isValueAliasDeclaration(node) ? node : undefined;
      case SyntaxKind.ModuleDeclaration:
      case SyntaxKind.ModuleBlock:
        return this.visitEachChild(node);
    }
    return node;
  }

  private importAttributes(node: ImportAttributes | undefined): ImportAttributes | undefined {
    const visited = this.visitNode(node);
    if (visited === undefined) return undefined;
    if (visited instanceof ImportAttributes) return visited;
    throw new Error('Expected import attributes');
  }

  private shouldEmitAliasDeclaration(node: Node): boolean {
    if ((node.flags & NodeFlags.JavaScriptFile) !== 0) return true;
    const parseNode = this.context.parseNode(node);
    return parseNode === undefined || this.resolver.isReferencedAliasDeclaration(parseNode);
  }

  private isValueAliasDeclaration(node: Node): boolean {
    const parseNode = this.context.parseNode(node);
    return parseNode === undefined || this.resolver.isValueAliasDeclaration(parseNode);
  }

  private isTopLevelValueImportEqualsWithEntityName(node: Node): boolean {
    const parseNode = this.context.parseNode(node);
    return parseNode !== undefined && this.resolver.isTopLevelValueImportEqualsWithEntityName(parseNode);
  }
}
