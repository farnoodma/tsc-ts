// Legacy (`experimentalDecorators`) decorators: decorated classes and members become
// `__decorate` calls after the class, and parameter decorators `__param` calls.
//
//   @dec class C { @m method(@p x) {} }
// becomes
//   let C = class C { method(x) {} };
//   __decorate([m, __param(0, p)], C.prototype, "method", null);
//   C = __decorate([dec], C);
//
// A decorated class that refers to itself inside its body gets an alias (`C_1`) for those
// references, since a class decorator can replace the class binding.
import {
  ClassDeclaration,
  ClassExpression,
  ClassStaticBlockDeclaration,
  ComputedPropertyName,
  ConstructorDeclaration,
  Decorator,
  ExportAssignment,
  ExportDeclaration,
  ExportSpecifier,
  GetAccessorDeclaration,
  Identifier,
  MethodDeclaration,
  ModifierFlags,
  type ModifierList,
  NamedExports,
  type Node,
  NodeVisitor,
  NodeFlags,
  NodeList,
  ParameterDeclaration,
  PrivateIdentifier,
  PropertyAccessExpression,
  PropertyDeclaration,
  SetAccessorDeclaration,
  SourceFile,
  getBody,
  getMembers,
  getName,
  getParameters,
} from '../ast.js';
import { canHaveDecorators } from '../ast-utilities.js';
import { isStatic } from '../binder-utilities.js';
import { type CompilerOptions, ScriptTarget, getEmitScriptTarget } from '../options.js';
import { createDecorateHelper, createParamHelper } from '../printer/decorator-helpers.js';
import type { EmitContext } from '../printer/emit-context.js';
import { EmitFlags } from '../printer/emit-flags.js';
import { NameOptions } from '../printer/factory.js';
import { skipPartiallyEmittedExpressions } from '../printer/utilities.js';
import { SyntaxKind } from '../syntax-kind.js';
import { TokenFlags } from '../types.js';
import {
  childIsDecorated,
  classOrConstructorParameterIsDecorated,
  getAllAccessorDeclarations,
  getDecorators,
  getFirstConstructorWithBody,
  isSimpleInlineableExpression,
  moveRangePastModifiers,
  nodeOrChildIsDecorated,
} from './decorator-utilities.js';
import type { EmitResolver } from './emit-resolver.js';
import { SubtreeFacts, type SyntaxFacts } from './syntax-facts.js';
import { Transformer } from './transformer.js';
import { hasDecorators, hasSyntacticModifier, isThisParameter } from './utilities.js';

/** The decorators of a declaration, and of its parameters by index. */
class AllDecorators {
  readonly decorators: Node[];
  readonly parameters: (Node[] | undefined)[];

  constructor(decorators: Node[], parameters: (Node[] | undefined)[]) {
    this.decorators = decorators;
    this.parameters = parameters;
  }
}

class ClassElementDecorations {
  readonly members: NodeList;
  readonly statements: Node[];

  constructor(members: NodeList, statements: Node[]) {
    this.members = members;
    this.statements = statements;
  }
}

export class LegacyDecorators extends Transformer {
  private readonly target: ScriptTarget;
  private readonly resolver: EmitResolver;
  private readonly facts: SyntaxFacts;
  /** Aliases of decorated classes that refer to themselves. */
  private readonly classAliases: Map<Node, Identifier>;
  /** Decorated classes with aliases whose bodies are being visited. */
  private enclosingClasses: ClassDeclaration[];

  constructor(context: EmitContext, options: CompilerOptions, resolver: EmitResolver, facts: SyntaxFacts) {
    super(context);
    this.target = getEmitScriptTarget(options);
    this.resolver = resolver;
    this.facts = facts;
    this.classAliases = new Map<Node, Identifier>();
    this.enclosingClasses = [];
  }

  visit(node: Node): Node | undefined {
    // Identifiers in classes with aliases may need substitution.
    if (!this.facts.has(node, SubtreeFacts.ContainsDecorators) && this.enclosingClasses.length === 0) return node;
    switch (node.kind) {
      case SyntaxKind.Identifier:
        return node instanceof Identifier ? this.visitIdentifier(node) : node;
      case SyntaxKind.PropertyAccessExpression:
        if (node instanceof PropertyAccessExpression) {
          // Property names are never substituted.
          const expression = this.visitNode(node.expression)!;
          return this.factory.updatePropertyAccessExpression(
            node,
            expression,
            node.questionDotToken,
            node.name,
            node.flags,
          );
        }
        break;
      case SyntaxKind.Decorator:
        // Emitted as part of the class.
        return undefined;
      case SyntaxKind.ClassDeclaration:
        if (node instanceof ClassDeclaration) return this.visitClassDeclaration(node);
        break;
      case SyntaxKind.ClassExpression:
        if (node instanceof ClassExpression)
          // Legacy decorators don't apply to class expressions.
          return this.factory.updateClassExpression(
            node,
            this.visitModifiers(node.modifiers),
            node.name,
            undefined,
            this.visitNodes(node.heritageClauses),
            this.visitNodes(node.members)!,
          );
        break;
      case SyntaxKind.Constructor:
        if (node instanceof ConstructorDeclaration)
          return this.factory.updateConstructorDeclaration(
            node,
            this.visitModifiers(node.modifiers),
            undefined,
            this.visitNodes(node.parameters)!,
            undefined,
            undefined,
            this.visitNode(node.body),
          );
        break;
      case SyntaxKind.MethodDeclaration:
        if (node instanceof MethodDeclaration)
          return this.finishClassElement(
            this.factory.updateMethodDeclaration(
              node,
              this.visitModifiers(node.modifiers),
              node.asteriskToken,
              this.visitPropertyNameOfClassElement(node),
              undefined,
              undefined,
              this.visitNodes(node.parameters)!,
              undefined,
              undefined,
              this.visitNode(node.body),
            ),
            node,
          );
        break;
      case SyntaxKind.GetAccessor:
        if (node instanceof GetAccessorDeclaration)
          return this.finishClassElement(
            this.factory.updateGetAccessorDeclaration(
              node,
              this.visitModifiers(node.modifiers),
              this.visitPropertyNameOfClassElement(node),
              undefined,
              this.visitNodes(node.parameters)!,
              undefined,
              undefined,
              this.visitNode(node.body),
            ),
            node,
          );
        break;
      case SyntaxKind.SetAccessor:
        if (node instanceof SetAccessorDeclaration)
          return this.finishClassElement(
            this.factory.updateSetAccessorDeclaration(
              node,
              this.visitModifiers(node.modifiers),
              this.visitPropertyNameOfClassElement(node),
              undefined,
              this.visitNodes(node.parameters)!,
              undefined,
              undefined,
              this.visitNode(node.body),
            ),
            node,
          );
        break;
      case SyntaxKind.PropertyDeclaration:
        if (node instanceof PropertyDeclaration) return this.visitPropertyDeclaration(node);
        break;
      case SyntaxKind.Parameter:
        if (node instanceof ParameterDeclaration) return this.visitParameter(node);
        break;
      case SyntaxKind.SourceFile:
        if (node instanceof SourceFile) return this.visitSourceFile(node);
        break;
    }
    return this.visitEachChild(node);
  }

  private visitSourceFile(node: SourceFile): Node {
    this.classAliases.clear();
    this.enclosingClasses = [];
    const result = this.visitEachChild(node);
    const helpers = this.context.readEmitHelpers();
    for (let i = 0; i < helpers.length; i++) this.context.addEmitHelper(result, helpers[i]!);
    this.classAliases.clear();
    return result;
  }

  /** A reference to a decorated class from inside its body becomes a reference to its alias. */
  private visitIdentifier(node: Identifier): Node {
    if (this.enclosingClasses.length === 0) return node;
    const declaration = this.getReferencedValueDeclaration(node);
    if (declaration === undefined) return node;
    for (let i = 0; i < this.enclosingClasses.length; i++) {
      const enclosing: Node = this.enclosingClasses[i]!;
      const alias = this.classAliases.get(enclosing);
      if (alias !== undefined && declaration === this.context.mostOriginal(enclosing)) return alias;
    }
    return node;
  }

  private finishClassElement(updated: Node, original: Node): Node {
    if (updated !== original) {
      // Source maps skip the decorators and modifiers; comments keep the original range.
      this.context.setCommentRange(updated, original.pos, original.end);
      const range = moveRangePastModifiers(original);
      this.context.setSourceMapRange(updated, range.pos, range.end);
    }
    return updated;
  }

  private visitParameter(node: ParameterDeclaration): Node {
    const updated = this.factory.updateParameterDeclaration(
      node,
      elideModifiers(this, node.modifiers),
      node.dotDotDotToken,
      this.visitNode(node.name)!,
      undefined,
      undefined,
      this.visitNode(node.initializer),
    );
    if (updated !== node) {
      this.context.setCommentRange(updated, node.pos, node.end);
      const range = moveRangePastModifiers(node);
      updated.pos = range.pos | 0;
      updated.end = range.end | 0;
      this.context.setSourceMapRange(updated, range.pos, range.end);
      if (updated instanceof ParameterDeclaration)
        this.context.setEmitFlags(updated.name, EmitFlags.NoTrailingSourceMap);
    }
    return updated;
  }

  /** The visited name of a class element; a decorated computed name is cached in a temporary for `__decorate`. */
  private visitPropertyNameOfClassElement(member: Node): Node {
    const name = getName(member)!;
    if (name instanceof ComputedPropertyName && hasDecorators(member)) {
      const expression = this.visitNode(name.expression)!;
      if (!isSimpleInlineableExpression(skipPartiallyEmittedExpressions(expression))) {
        const generated = this.factory.createGeneratedNameForNode(name, 0, '', '');
        this.context.addVariableDeclaration(generated);
        return this.factory.updateComputedPropertyName(name, this.factory.createAssignment(generated, expression));
      }
    }
    return this.visitNode(name)!;
  }

  private visitPropertyDeclaration(node: PropertyDeclaration): Node | undefined {
    if ((node.flags & NodeFlags.Ambient) !== 0) return undefined;
    if (hasSyntacticModifier(node, ModifierFlags.Ambient | ModifierFlags.Abstract)) return undefined;
    return this.finishClassElement(
      this.factory.updatePropertyDeclaration(
        node,
        this.visitModifiers(node.modifiers),
        this.visitPropertyNameOfClassElement(node),
        undefined,
        undefined,
        this.visitNode(node.initializer),
      ),
      node,
    );
  }

  // Classes

  private visitClassDeclaration(node: ClassDeclaration): Node | undefined {
    const decorated = classOrConstructorParameterIsDecorated(true, node);
    if (!decorated && !childIsDecorated(true, node, undefined)) return this.visitEachChild(node);
    if (decorated) return this.transformClassDeclarationWithClassDecorators(node, node.name);
    return this.transformClassDeclarationWithoutClassDecorators(node, node.name);
  }

  private transformClassDeclarationWithoutClassDecorators(node: ClassDeclaration, name: Identifier | undefined): Node {
    const modifiers = this.visitModifiers(node.modifiers);
    const heritageClauses = this.visitNodes(node.heritageClauses);
    const visitedMembers = this.visitNodes(node.members)!;
    const decorations = this.transformDecoratorsOfClassElements(node, visitedMembers);
    const members = decorations.members;
    const decorationStatements = decorations.statements;
    if (name === undefined && decorationStatements.length > 0)
      name = this.factory.createGeneratedNameForNode(node, 0, '', '');
    const updated = this.factory.updateClassDeclaration(node, modifiers, name, undefined, heritageClauses, members);
    if (decorationStatements.length === 0) return updated;
    return this.factory.createSyntaxList([updated as Node].concat(decorationStatements));
  }

  /**
   * A decorated class becomes `let C = class C {}` followed by the decorations; an export of it
   * moves after them.
   */
  private transformClassDeclarationWithClassDecorators(node: ClassDeclaration, name: Identifier | undefined): Node {
    const factory = this.factory;
    const context = this.context;
    const isExport = hasSyntacticModifier(node, ModifierFlags.Export);
    const isDefault = hasSyntacticModifier(node, ModifierFlags.Default);
    let modifiers: ModifierList | undefined = undefined;
    if (node.modifiers !== undefined && node.modifiers.nodes.length > 0) {
      const kept: Node[] = [];
      for (let i = 0; i < node.modifiers.nodes.length; i++) {
        const modifier = node.modifiers.nodes[i]!;
        if (
          !(modifier instanceof Decorator) &&
          modifier.kind !== SyntaxKind.ExportKeyword &&
          modifier.kind !== SyntaxKind.DefaultKeyword
        )
          kept.push(modifier);
      }
      if (kept.length !== node.modifiers.nodes.length) {
        modifiers = factory.createModifierList(kept);
        modifiers.pos = node.modifiers.pos;
        modifiers.end = node.modifiers.end;
      } else modifiers = node.modifiers;
    }

    const location = moveRangePastModifiers(node);
    const classAlias = this.getClassAliasIfNeeded(node);
    if (classAlias !== undefined) this.enclosingClasses.push(node);

    // Always the local name: there are no ES5 IIFEs to name differently.
    const declarationName = factory.getLocalName(node, NameOptions.AllowSourceMaps);
    const heritageClauses = this.visitNodes(node.heritageClauses);
    const visitedMembers = this.visitNodes(node.members)!;
    const decorations = this.transformDecoratorsOfClassElements(node, visitedMembers);
    let members = decorations.members;
    const decorationStatements = decorations.statements;

    // From ES2022, the alias must be assigned before static initializers run.
    const assignClassAliasInStaticBlock =
      this.target >= ScriptTarget.ES2022 &&
      classAlias !== undefined &&
      members.nodes.length > 0 &&
      members.nodes.some(isClassStaticBlockDeclarationOrStaticProperty);
    if (assignClassAliasInStaticBlock) {
      const block = factory.created(
        new ClassStaticBlockDeclaration(
          undefined,
          factory.createBlock(
            [
              factory.createExpressionStatement(
                factory.createAssignment(classAlias!, factory.createKeywordExpression(SyntaxKind.ThisKeyword)),
              ),
            ],
            false,
          ),
        ),
      );
      const list = factory.createNodeList([block as Node].concat(members.nodes));
      list.pos = members.pos;
      list.end = members.end;
      members = list;
    }

    const expressionName = name !== undefined && context.hasAutoGenerateInfo(name) ? undefined : name;
    const classExpression = factory.created(
      new ClassExpression(modifiers, expressionName, undefined, heritageClauses, members),
    );
    context.setOriginal(classExpression, node);
    classExpression.pos = location.pos | 0;
    classExpression.end = location.end | 0;

    const initializer =
      classAlias !== undefined && !assignClassAliasInStaticBlock
        ? factory.createAssignment(classAlias, classExpression)
        : classExpression;
    const declaration = factory.createVariableDeclaration(declarationName, undefined, undefined, initializer);
    context.setOriginal(declaration, node);
    const statement = factory.createVariableStatement(
      undefined,
      factory.createVariableDeclarationList(factory.createNodeList([declaration]), NodeFlags.Let),
    );
    context.setOriginal(statement, node);
    statement.pos = location.pos | 0;
    statement.end = location.end | 0;
    context.setCommentRange(statement, node.pos, node.end);

    const statements: Node[] = [statement];
    for (let i = 0; i < decorationStatements.length; i++) statements.push(decorationStatements[i]!);
    const constructorDecoration = this.getConstructorDecorationStatement(node);
    if (constructorDecoration !== undefined) statements.push(constructorDecoration);
    if (isExport) {
      if (isDefault)
        statements.push(factory.created(new ExportAssignment(undefined, false, undefined, declarationName)));
      else {
        const specifier = factory.created(
          new ExportSpecifier(false, undefined, factory.getDeclarationName(node, NameOptions.None)),
        );
        statements.push(
          factory.created(
            new ExportDeclaration(
              undefined,
              false,
              factory.created(new NamedExports(factory.createNodeList([specifier]))),
              undefined,
              undefined,
            ),
          ),
        );
      }
    }
    if (classAlias !== undefined) this.enclosingClasses.pop();
    return statements.length === 1 ? statements[0] : factory.createSyntaxList(statements);
  }

  /** Whether a member refers to the class by name, other than as a property name. */
  private hasInternalStaticReference(node: ClassDeclaration): boolean {
    const classNode = this.context.mostOriginal(node);
    const members = node.members.nodes;
    const finder = new SelfReferenceFinder(this, classNode);
    for (let i = 0; i < members.length; i++) if (members[i].forEachChild(finder)) return true;
    return false;
  }

  isReferenceTo(node: Node, declaration: Node): boolean {
    return node instanceof Identifier && this.getReferencedValueDeclaration(node as Identifier) === declaration;
  }

  /** The declaration the parse-tree identifier behind `node` refers to. */
  private getReferencedValueDeclaration(node: Identifier): Node | undefined {
    const original = this.context.mostOriginal(node);
    if (original instanceof Identifier && (original.flags & NodeFlags.Synthesized) === 0) {
      return this.resolver.getReferencedValueDeclaration(original as Identifier);
    }
    return undefined;
  }

  private getClassAliasIfNeeded(node: ClassDeclaration): Identifier | undefined {
    if (!this.hasInternalStaticReference(node)) return undefined;
    const name = node.name;
    const text = name !== undefined && !this.context.hasAutoGenerateInfo(name) ? name.text : 'default';
    const alias = this.factory.createUniqueName(text, 0);
    this.context.addVariableDeclaration(alias);
    this.classAliases.set(node as Node, alias);
    return alias;
  }

  private getConstructorDecorationStatement(node: ClassDeclaration): Node | undefined {
    const expression = this.generateConstructorDecorationExpression(node);
    if (expression === undefined) return undefined;
    const statement = this.factory.createExpressionStatement(expression);
    this.context.setOriginal(statement, node);
    return statement;
  }

  /** `C = __decorate([...], C)`, or `C = C_1 = __decorate([...], C)` with an alias. */
  private generateConstructorDecorationExpression(node: ClassDeclaration): Node | undefined {
    const all = getAllDecoratorsOfClass(node);
    // Class decorators are evaluated outside the class body, where its name isn't aliased.
    const enclosing = this.enclosingClasses;
    const aliased = enclosing.length > 0 && enclosing[enclosing.length - 1] === node;
    if (aliased) enclosing.pop();
    const decoratorExpressions = this.transformAllDecoratorsOfDeclaration(all);
    if (aliased) enclosing.push(node);
    if (decoratorExpressions.length === 0) return undefined;
    const factory = this.factory;
    const classAlias = this.classAliases.get(node as Node);
    const localName = factory.getDeclarationName(node, NameOptions.AllowSourceMaps);
    const decorate = createDecorateHelper(factory, decoratorExpressions, localName, undefined, undefined);
    const value = classAlias !== undefined ? factory.createAssignment(classAlias, decorate) : decorate;
    const expression = factory.createAssignment(localName, value);
    this.context.setEmitFlags(expression, EmitFlags.NoComments);
    const range = moveRangePastModifiers(node);
    this.context.setSourceMapRange(expression, range.pos, range.end);
    return expression;
  }

  // Members

  /** The members, and the statements decorating them after the class. */
  private transformDecoratorsOfClassElements(node: ClassDeclaration, members: NodeList): ClassElementDecorations {
    const statements: Node[] = [];
    this.addClassElementDecorationStatements(node, false, statements);
    this.addClassElementDecorationStatements(node, true, statements);
    // Decorators using private names must run in the class's private name scope.
    if (!this.hasClassElementWithDecoratorContainingPrivateIdentifierInExpression(node))
      return new ClassElementDecorations(members, statements);
    const block = this.factory.created(
      new ClassStaticBlockDeclaration(undefined, this.factory.createBlock(statements, true)),
    );
    const extra: Node[] = [block];
    return new ClassElementDecorations(this.factory.createNodeList(members.nodes.concat(extra)), []);
  }

  private hasClassElementWithDecoratorContainingPrivateIdentifierInExpression(node: ClassDeclaration): boolean {
    const members = node.members.nodes;
    for (let i = 0; i < members.length; i++) {
      const member = members[i]!;
      if (!canHaveDecorators(member)) continue;
      const all = getAllDecoratorsOfClassElement(member, node);
      if (all === undefined) continue;
      if (this.someContainsPrivateIdentifierInExpression(all.decorators)) return true;
      for (let j = 0; j < all.parameters.length; j++) {
        const parameter = all.parameters[j];
        if (parameter !== undefined && this.someContainsPrivateIdentifierInExpression(parameter)) return true;
      }
    }
    return false;
  }

  private someContainsPrivateIdentifierInExpression(decorators: Node[]): boolean {
    for (let i = 0; i < decorators.length; i++)
      if (this.facts.has(decorators[i]!, SubtreeFacts.ContainsPrivateIdentifierInExpression)) return true;
    return false;
  }

  /** `__decorate` statements for the static or instance members. */
  private addClassElementDecorationStatements(
    node: ClassDeclaration,
    isStaticMember: boolean,
    statements: Node[],
  ): boolean {
    const members = node.members.nodes;
    for (let i = 0; i < members.length; i++) {
      const member = members[i]!;
      if (isStatic(member) !== isStaticMember || !nodeOrChildIsDecorated(true, member, node, undefined)) continue;
      const expression = this.generateClassElementDecorationExpression(node, member);
      if (expression !== undefined) statements.push(this.factory.createExpressionStatement(expression));
    }
    return true;
  }

  /**
   * `__decorate([...], C.prototype, "name", null)` for a method or accessor, or with `void 0`
   * for a property, so `__decorate` defines it without reading its descriptor first.
   */
  private generateClassElementDecorationExpression(node: ClassDeclaration, member: Node): Node | undefined {
    const all = getAllDecoratorsOfClassElement(member, node);
    const decoratorExpressions = this.transformAllDecoratorsOfDeclaration(all);
    if (decoratorExpressions.length === 0) return undefined;
    const factory = this.factory;
    const prefix: Node = isStatic(member)
      ? factory.getDeclarationName(node, NameOptions.None)
      : factory.createPropertyAccessExpression(
          factory.getDeclarationName(node, NameOptions.None),
          factory.createIdentifier('prototype'),
        );
    const memberName = this.getExpressionForPropertyName(member, (member.flags & NodeFlags.Ambient) === 0);
    const descriptor =
      member instanceof PropertyDeclaration && !hasSyntacticModifier(member, ModifierFlags.Accessor)
        ? factory.createVoidZero()
        : factory.createKeywordExpression(SyntaxKind.NullKeyword);
    const helper = createDecorateHelper(factory, decoratorExpressions, prefix, memberName, descriptor);
    this.context.setEmitFlags(helper, EmitFlags.NoComments);
    const range = moveRangePastModifiers(member);
    this.context.setSourceMapRange(helper, range.pos, range.end);
    return helper;
  }

  /** The decorator expressions, then `__param` calls, then `__metadata` calls. */
  private transformAllDecoratorsOfDeclaration(all: AllDecorators | undefined): Node[] {
    const expressions: Node[] = [];
    if (all === undefined) return expressions;
    const metadata: Node[] = [];
    for (let i = 0; i < all.decorators.length; i++) {
      const decorator = all.decorators[i]!;
      if (decorator instanceof Decorator && this.factory.isCallToHelper(decorator.expression, '__metadata'))
        metadata.push(decorator);
      else expressions.push(this.visitDecoratorExpression(decorator));
    }
    for (let i = 0; i < all.parameters.length; i++) {
      const decorators = all.parameters[i];
      if (decorators === undefined) continue;
      for (let j = 0; j < decorators.length; j++) {
        const decorator = decorators[j]!;
        if (!(decorator instanceof Decorator)) continue;
        const expression = decorator.expression;
        const helper = createParamHelper(this.factory, this.visitNode(expression)!, i, expression.pos, expression.end);
        this.context.setEmitFlags(helper, EmitFlags.NoComments);
        expressions.push(helper);
      }
    }
    for (let i = 0; i < metadata.length; i++) expressions.push(this.visitDecoratorExpression(metadata[i]!));
    return expressions;
  }

  private visitDecoratorExpression(decorator: Node): Node {
    return decorator instanceof Decorator ? this.visitNode(decorator.expression)! : decorator;
  }

  private getExpressionForPropertyName(member: Node, generateNameForComputedPropertyName: boolean): Node {
    const name = getName(member)!;
    const factory = this.factory;
    if (name instanceof PrivateIdentifier) return factory.createIdentifier('');
    if (name instanceof ComputedPropertyName) {
      if (generateNameForComputedPropertyName && !isSimpleInlineableExpression(name.expression))
        return factory.createGeneratedNameForNode(name, 0, '', '');
      return name.expression;
    }
    if (name instanceof Identifier) return factory.createStringLiteral(name.text, TokenFlags.None);
    return factory.cloneNode(name, name.deepClone());
  }
}

/** Finds a reference to a class among the children of its members; property names don't count. */
class SelfReferenceFinder extends NodeVisitor {
  private readonly transformer: LegacyDecorators;
  private readonly declaration: Node;

  constructor(transformer: LegacyDecorators, declaration: Node) {
    super();
    this.transformer = transformer;
    this.declaration = declaration;
  }

  visitNode(node: Node): boolean {
    if (this.transformer.isReferenceTo(node, this.declaration)) return true;
    if (node instanceof PropertyAccessExpression) return this.visitNode(node.expression);
    return node.forEachChild(this);
  }
}

function elideModifiers(transformer: Transformer, modifiers: ModifierList | undefined): ModifierList | undefined {
  if (modifiers === undefined || modifiers.nodes.length === 0) return modifiers;
  const replacement = transformer.factory.createModifierList([]);
  replacement.pos = modifiers.pos;
  replacement.end = modifiers.end;
  return replacement;
}

function isClassStaticBlockDeclarationOrStaticProperty(node: Node): boolean {
  return (
    node.kind === SyntaxKind.ClassStaticBlockDeclaration ||
    (node.kind === SyntaxKind.PropertyDeclaration && hasSyntacticModifier(node, ModifierFlags.Static))
  );
}

function getAllDecoratorsOfClass(node: ClassDeclaration): AllDecorators | undefined {
  const decorators = getDecorators(node);
  const parameters = getDecoratorsOfParameters(getFirstConstructorWithBody(node));
  if (decorators.length === 0 && parameters.length === 0) return undefined;
  return new AllDecorators(decorators, parameters);
}

function getAllDecoratorsOfClassElement(member: Node, parent: ClassDeclaration): AllDecorators | undefined {
  switch (member.kind) {
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
      return getAllDecoratorsOfAccessors(member, parent);
    case SyntaxKind.MethodDeclaration:
      return getAllDecoratorsOfMethod(member);
    case SyntaxKind.PropertyDeclaration: {
      const decorators = getDecorators(member);
      return decorators.length === 0 ? undefined : new AllDecorators(decorators, []);
    }
  }
  return undefined;
}

/** Decorators of an accessor pair apply once, on the first accessor that has them. */
function getAllDecoratorsOfAccessors(accessor: Node, parent: ClassDeclaration): AllDecorators | undefined {
  if (getBody(accessor) === undefined) return undefined;
  const accessors = getAllAccessorDeclarations(getMembers(parent)!.nodes, accessor);
  const first = accessors.firstWithDecorators();
  if (first === undefined || accessor !== first) return undefined;
  const decorators = getDecorators(first);
  const parameters =
    accessors.setAccessor !== undefined ? getDecoratorsOfParameters(accessors.setAccessor) : noParameters;
  if (decorators.length === 0 && parameters.length === 0) return undefined;
  return new AllDecorators(decorators, parameters);
}

function getAllDecoratorsOfMethod(method: Node): AllDecorators | undefined {
  if (!(method instanceof MethodDeclaration) || method.body === undefined) return undefined;
  const decorators = getDecorators(method);
  const parameters = getDecoratorsOfParameters(method);
  if (decorators.length === 0 && parameters.length === 0) return undefined;
  return new AllDecorators(decorators, parameters);
}

const noParameters: (Node[] | undefined)[] = [];

/** The decorators of each parameter after `this`, or an empty array if none are decorated. */
function getDecoratorsOfParameters(node: Node | undefined): (Node[] | undefined)[] {
  const result: (Node[] | undefined)[] = [];
  if (node === undefined) return result;
  const parameters = getParameters(node)!.nodes;
  const offset = parameters.length > 0 && isThisParameter(parameters[0]!) ? 1 : 0;
  const count = parameters.length - offset;
  for (let i = 0; i < count; i++) {
    const parameter = parameters[i + offset]!;
    if (result.length > 0 || hasDecorators(parameter)) {
      if (result.length === 0) for (let j = 0; j < count; j++) result.push(undefined);
      result[i] = getDecorators(parameter);
    }
  }
  return result;
}
