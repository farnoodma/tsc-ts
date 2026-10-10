// ES2018 async iteration: async generators become generators run by `__asyncGenerator`, and
// `for await` loops iterate `__asyncValues(x)` by hand, closing the iterator on early exit.
import {
  ArrowFunction,
  Block,
  CatchClause,
  ConstructorDeclaration,
  ForInOrOfStatement,
  ForStatement,
  FunctionDeclaration,
  FunctionExpression,
  GetAccessorDeclaration,
  Identifier,
  IfStatement,
  LabeledStatement,
  MethodDeclaration,
  ModifierFlags,
  type ModifierList,
  type Node,
  NodeFlags,
  type NodeList,
  ParameterDeclaration,
  ReturnStatement,
  SetAccessorDeclaration,
  SourceFile,
  ThrowStatement,
  TryStatement,
  VariableDeclarationList,
  YieldExpression,
  AwaitExpression,
  getBody,
  getName,
  getParameters,
} from '../ast.js';
import {
  advancedAsyncSuperHelper,
  asyncSuperHelper,
  createAsyncDelegatorHelper,
  createAsyncGeneratorHelper,
  createAsyncValuesHelper,
  createAwaitHelper,
} from '../printer/async-helpers.js';
import type { EmitContext } from '../printer/emit-context.js';
import { EmitFlags, GeneratedIdentifierFlags } from '../printer/emit-flags.js';
import { SyntaxKind } from '../syntax-kind.js';
import { FunctionFlags, SuperAccess, getFunctionFlags, isSimpleParameterList } from './async-utilities.js';
import { SubtreeFacts, type SyntaxFacts } from './syntax-facts.js';
import { Transformer } from './transformer.js';
import { VisitorBase } from './visitor-base.js';

const enum HierarchyFacts {
  None = 0,
  HasLexicalThis = 1 << 0,
  IterationContainer = 1 << 1,
}

/** Visits subtrees without async iteration, tracking `super` accesses only. */
class FallbackVisitor extends VisitorBase {
  readonly owner: AsyncIteration;

  constructor(owner: AsyncIteration) {
    super(owner.context);
    this.owner = owner;
  }

  visit(node: Node): Node | undefined {
    return this.owner.fallback(node);
  }
}

export class AsyncIteration extends Transformer {
  private readonly facts: SyntaxFacts;
  private readonly superAccess: SuperAccess;
  private readonly fallbackVisitor: FallbackVisitor;
  private enclosingFunctionFlags: FunctionFlags;
  private hierarchyFacts: HierarchyFacts;

  constructor(context: EmitContext, facts: SyntaxFacts) {
    super(context);
    this.facts = facts;
    this.superAccess = new SuperAccess(context);
    this.fallbackVisitor = new FallbackVisitor(this);
    this.enclosingFunctionFlags = FunctionFlags.Normal;
    this.hierarchyFacts = HierarchyFacts.None;
  }

  fallback(node: Node): Node | undefined {
    if (this.superAccess.capturedSuperProperties === undefined) return node;
    switch (node.kind) {
      case SyntaxKind.FunctionExpression:
      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor:
      case SyntaxKind.Constructor:
        return node;
    }
    this.superAccess.track(node);
    return this.fallbackVisitor.visitEachChild(node);
  }

  private inAsyncGenerator(): boolean {
    return (this.enclosingFunctionFlags & FunctionFlags.AsyncGenerator) === FunctionFlags.AsyncGenerator;
  }

  visit(node: Node): Node | undefined {
    if (!this.facts.has(node, SubtreeFacts.ContainsForAwaitOrAsyncGenerator)) return this.fallback(node);
    this.superAccess.track(node);
    switch (node.kind) {
      case SyntaxKind.SourceFile:
        if (node instanceof SourceFile) return this.visitSourceFile(node);
        break;
      case SyntaxKind.AwaitExpression:
        if (node instanceof AwaitExpression) return this.visitAwaitExpression(node);
        break;
      case SyntaxKind.YieldExpression:
        if (node instanceof YieldExpression) return this.visitYieldExpression(node);
        break;
      case SyntaxKind.ReturnStatement:
        if (node instanceof ReturnStatement) return this.visitReturnStatement(node);
        break;
      case SyntaxKind.LabeledStatement:
        if (node instanceof LabeledStatement) return this.visitLabeledStatement(node);
        break;
      case SyntaxKind.DoStatement:
      case SyntaxKind.WhileStatement:
      case SyntaxKind.ForInStatement:
      case SyntaxKind.ForStatement:
        return this.visitWithFacts(node, HierarchyFacts.None, HierarchyFacts.IterationContainer);
      case SyntaxKind.ForOfStatement:
        if (node instanceof ForInOrOfStatement) return this.visitForOfStatement(node, undefined);
        break;
      case SyntaxKind.ArrowFunction:
        return this.visitWithFacts(node, HierarchyFacts.IterationContainer, HierarchyFacts.None);
      case SyntaxKind.Constructor:
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor:
      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.FunctionExpression:
      case SyntaxKind.ClassDeclaration:
      case SyntaxKind.ClassExpression:
        return this.visitWithFacts(node, HierarchyFacts.IterationContainer, HierarchyFacts.HasLexicalThis);
    }
    return this.visitEachChild(node);
  }

  private visitWithFacts(node: Node, exclude: HierarchyFacts, include: HierarchyFacts): Node {
    const ancestorFacts = this.hierarchyFacts;
    this.hierarchyFacts = (ancestorFacts & ~exclude) | include;
    const result = this.visitScope(node);
    this.hierarchyFacts = ancestorFacts;
    return result;
  }

  private visitScope(node: Node): Node {
    if (node instanceof ConstructorDeclaration) return this.visitConstructor(node);
    if (node instanceof MethodDeclaration) return this.visitMethodDeclaration(node);
    if (node instanceof GetAccessorDeclaration) return this.visitGetAccessor(node);
    if (node instanceof SetAccessorDeclaration) return this.visitSetAccessor(node);
    if (node instanceof FunctionDeclaration) return this.visitFunctionDeclaration(node);
    if (node instanceof FunctionExpression) return this.visitFunctionExpression(node);
    if (node instanceof ArrowFunction) return this.visitArrowFunction(node);
    return this.visitEachChild(node);
  }

  private visitSourceFile(node: SourceFile): Node {
    const ancestorFacts = this.hierarchyFacts;
    this.hierarchyFacts = ancestorFacts & ~HierarchyFacts.IterationContainer;
    const visited = this.visitEachChild(node);
    const helpers = this.context.readEmitHelpers();
    for (let i = 0; i < helpers.length; i++) this.context.addEmitHelper(visited, helpers[i]);
    this.hierarchyFacts = ancestorFacts;
    return visited;
  }

  /** `await x` in an async generator as `yield __await(x)`. */
  private visitAwaitExpression(node: AwaitExpression): Node {
    if (!this.inAsyncGenerator()) return this.visitEachChild(node);
    const factory = this.factory;
    const result = factory.created(
      new YieldExpression(undefined, createAwaitHelper(factory, this.visitNode(node.expression)!)),
    );
    result.pos = node.pos;
    result.end = node.end;
    this.context.setOriginal(result, node);
    return result;
  }

  /** `yield x` as `yield yield __await(x)`; `yield* x` as `yield __await(yield* __asyncDelegator(__asyncValues(x)))`. */
  private visitYieldExpression(node: YieldExpression): Node {
    if (!this.inAsyncGenerator()) return this.visitEachChild(node);
    const factory = this.factory;
    let inner: Node;
    if (node.asteriskToken !== undefined) {
      const expression = this.visitNode(node.expression)!;
      const values = createAsyncValuesHelper(factory, expression);
      values.pos = expression.pos;
      values.end = expression.end;
      const delegator = createAsyncDelegatorHelper(factory, values);
      delegator.pos = expression.pos;
      delegator.end = expression.end;
      inner = createAwaitHelper(factory, factory.updateYieldExpression(node, node.asteriskToken, delegator));
    } else
      inner = this.createDownlevelAwait(
        node.expression !== undefined ? this.visitNode(node.expression)! : factory.createVoidZero(),
      );
    const result = factory.created(new YieldExpression(undefined, inner));
    result.pos = node.pos;
    result.end = node.end;
    this.context.setOriginal(result, node);
    return result;
  }

  private visitReturnStatement(node: ReturnStatement): Node {
    if (!this.inAsyncGenerator()) return this.visitEachChild(node);
    const expression = node.expression !== undefined ? this.visitNode(node.expression)! : this.factory.createVoidZero();
    return this.factory.updateReturnStatement(node, this.createDownlevelAwait(expression));
  }

  private visitLabeledStatement(node: LabeledStatement): Node | undefined {
    if ((this.enclosingFunctionFlags & FunctionFlags.Async) === 0) return this.visitEachChild(node);
    let innermost = node;
    while (innermost.statement instanceof LabeledStatement) innermost = innermost.statement;
    const statement = innermost.statement;
    if (statement instanceof ForInOrOfStatement && statement.awaitModifier !== undefined)
      return this.visitForOfStatement(statement, node);
    return this.restoreEnclosingLabel(this.visitNode(statement)!, node);
  }

  private restoreEnclosingLabel(node: Node, outermost: LabeledStatement | undefined): Node {
    if (outermost === undefined) return node;
    const inner =
      outermost.statement instanceof LabeledStatement ? this.restoreEnclosingLabel(node, outermost.statement) : node;
    return this.factory.updateLabeledStatement(outermost, outermost.label, inner);
  }

  private visitForOfStatement(node: ForInOrOfStatement, outermost: LabeledStatement | undefined): Node {
    const ancestorFacts = this.hierarchyFacts;
    this.hierarchyFacts = ancestorFacts | HierarchyFacts.IterationContainer;
    const result =
      node.awaitModifier !== undefined
        ? this.transformForAwaitOfStatement(node, outermost, ancestorFacts)
        : this.restoreEnclosingLabel(this.visitEachChild(node), outermost);
    this.hierarchyFacts = ancestorFacts;
    return result;
  }

  private createDownlevelAwait(expression: Node): Node {
    const factory = this.factory;
    if ((this.enclosingFunctionFlags & FunctionFlags.Generator) !== 0)
      return factory.created(new YieldExpression(undefined, createAwaitHelper(factory, expression)));
    return factory.created(new AwaitExpression(expression));
  }

  /** The loop body: assigns the iterated value, clears `nonUserCode`, binds the loop variable. */
  private convertForOfStatementHead(node: ForInOrOfStatement, boundValue: Node, nonUserCode: Identifier): Node {
    const factory = this.factory;
    const context = this.context;
    const value = factory.createTempVariable(GeneratedIdentifierFlags.None);
    context.addVariableDeclaration(value);
    const valueStatement = factory.createExpressionStatement(factory.createAssignment(value, boundValue));
    context.setSourceMapRange(valueStatement, node.expression.pos, node.expression.end);
    const exitNonUserCode = factory.createExpressionStatement(
      factory.createAssignment(nonUserCode, factory.createKeywordExpression(SyntaxKind.FalseKeyword)),
    );
    context.setSourceMapRange(exitNonUserCode, node.expression.pos, node.expression.end);
    const statements: Node[] = [valueStatement, exitNonUserCode];
    statements.push(this.visitNode(this.createForOfBindingStatement(node.initializer, value))!);
    const statement = this.visitEmbeddedStatement(node.statement)!;
    // Without a block body, tsgo leaves both ranges empty at the start of the file.
    let pos = 0;
    let end = 0;
    let listPos = 0;
    let listEnd = 0;
    if (statement instanceof Block) {
      const nodes = statement.statements.nodes;
      for (let i = 0; i < nodes.length; i++) statements.push(nodes[i]);
      pos = statement.pos;
      end = statement.end;
      listPos = statement.statements.pos;
      listEnd = statement.statements.end;
    } else statements.push(statement);
    const block = factory.createBlock(statements, true);
    block.statements.pos = listPos;
    block.statements.end = listEnd;
    block.pos = pos;
    block.end = end;
    return block;
  }

  private createForOfBindingStatement(node: Node, boundValue: Node): Node {
    const factory = this.factory;
    if (node instanceof VariableDeclarationList) {
      const first = node.declarations.nodes[0];
      const declaration = factory.createVariableDeclaration(getName(first)!, undefined, undefined, boundValue);
      factory.cloneNode(first, declaration);
      const statement = factory.createVariableStatement(
        undefined,
        factory.updateVariableDeclarationList(node, factory.createNodeList([declaration]), node.flags),
      );
      statement.pos = node.pos;
      statement.end = node.end;
      return statement;
    }
    const assignment = factory.createAssignment(node, boundValue);
    assignment.pos = node.pos;
    assignment.end = node.end;
    const statement = factory.createExpressionStatement(assignment);
    statement.pos = node.pos;
    statement.end = node.end;
    return statement;
  }

  private transformForAwaitOfStatement(
    node: ForInOrOfStatement,
    outermost: LabeledStatement | undefined,
    ancestorFacts: HierarchyFacts,
  ): Node {
    const factory = this.factory;
    const context = this.context;
    const expression = this.visitNode(node.expression)!;
    const iterator =
      expression instanceof Identifier
        ? factory.createGeneratedNameForNode(expression, GeneratedIdentifierFlags.None, '', '')
        : factory.createTempVariable(GeneratedIdentifierFlags.None);
    const result =
      expression instanceof Identifier
        ? factory.createGeneratedNameForNode(iterator, GeneratedIdentifierFlags.None, '', '')
        : factory.createTempVariable(GeneratedIdentifierFlags.None);
    const nonUserCode = factory.createTempVariable(GeneratedIdentifierFlags.None);
    const done = factory.createTempVariable(GeneratedIdentifierFlags.None);
    context.addVariableDeclaration(done);
    const errorRecord = factory.createUniqueName('e', GeneratedIdentifierFlags.None);
    const catchVariable = factory.createGeneratedNameForNode(errorRecord, GeneratedIdentifierFlags.None, '', '');
    const returnMethod = factory.createTempVariable(GeneratedIdentifierFlags.None);
    const callValues = createAsyncValuesHelper(factory, expression);
    callValues.pos = node.expression.pos;
    callValues.end = node.expression.end;
    const callNext = factory.createCallExpression(
      factory.createPropertyAccessExpression(iterator, factory.createIdentifier('next')),
      [],
    );
    const getDone = factory.createPropertyAccessExpression(result, factory.createIdentifier('done'));
    const getValue = factory.createPropertyAccessExpression(result, factory.createIdentifier('value'));
    const callReturn = factory.createCallExpression(
      factory.createPropertyAccessExpression(returnMethod, factory.createIdentifier('call')),
      [iterator],
    );
    context.addVariableDeclaration(errorRecord);
    context.addVariableDeclaration(returnMethod);

    // In an outer loop, reset the error record on each iteration.
    const initializer =
      (ancestorFacts & HierarchyFacts.IterationContainer) !== 0
        ? factory.inlineExpressions([factory.createAssignment(errorRecord, factory.createVoidZero()), callValues])!
        : callValues;
    const iteratorDeclaration = factory.createVariableDeclaration(iterator, undefined, undefined, initializer);
    iteratorDeclaration.pos = node.expression.pos;
    iteratorDeclaration.end = node.expression.end;
    const declarations = factory.createVariableDeclarationList(
      factory.createNodeList([
        factory.createVariableDeclaration(
          nonUserCode,
          undefined,
          undefined,
          factory.createKeywordExpression(SyntaxKind.TrueKeyword),
        ),
        iteratorDeclaration,
        factory.createVariableDeclaration(result, undefined, undefined, undefined),
      ]),
      NodeFlags.None,
    );
    declarations.pos = node.expression.pos;
    declarations.end = node.expression.end;
    const condition = factory.inlineExpressions([
      factory.createAssignment(result, this.createDownlevelAwait(callNext)),
      factory.createAssignment(done, getDone),
      factory.createPrefixUnaryExpression(SyntaxKind.ExclamationToken, done),
    ])!;
    const incrementor = factory.createAssignment(nonUserCode, factory.createKeywordExpression(SyntaxKind.TrueKeyword));
    const forStatement = factory.created(
      new ForStatement(
        declarations,
        condition,
        incrementor,
        this.convertForOfStatementHead(node, getValue, nonUserCode),
      ),
    );
    forStatement.pos = node.pos;
    forStatement.end = node.end;
    context.addEmitFlags(forStatement, EmitFlags.NoTokenTrailingSourceMaps);
    context.setOriginal(forStatement, node);

    const tryBlock = factory.createBlock([this.restoreEnclosingLabel(forStatement, outermost)], true);
    // catch (e_1_1) { e_1 = { error: e_1_1 }; }
    const catchBody = factory.createBlock(
      [
        factory.createExpressionStatement(
          factory.createAssignment(
            errorRecord,
            factory.createObjectLiteral(
              [factory.createPropertyAssignment(factory.createIdentifier('error'), catchVariable)],
              false,
            ),
          ),
        ),
      ],
      false,
    );
    context.addEmitFlags(catchBody, EmitFlags.SingleLine);
    const catchClause = factory.created(
      new CatchClause(factory.createVariableDeclaration(catchVariable, undefined, undefined, undefined), catchBody),
    );
    // if (!nonUserCode && !done && (returnMethod = iterator.return)) await returnMethod.call(iterator);
    const closeCondition = factory.createBinaryExpression(
      factory.createBinaryExpression(
        factory.createPrefixUnaryExpression(SyntaxKind.ExclamationToken, nonUserCode),
        SyntaxKind.AmpersandAmpersandToken,
        factory.createPrefixUnaryExpression(SyntaxKind.ExclamationToken, done),
      ),
      SyntaxKind.AmpersandAmpersandToken,
      factory.createAssignment(
        returnMethod,
        factory.createPropertyAccessExpression(iterator, factory.createIdentifier('return')),
      ),
    );
    const close = factory.createIfStatement(
      closeCondition,
      factory.createExpressionStatement(this.createDownlevelAwait(callReturn)),
      undefined,
    );
    context.addEmitFlags(close, EmitFlags.SingleLine);
    // if (e_1) throw e_1.error;
    const rethrow = factory.created(
      new IfStatement(
        errorRecord,
        factory.created(
          new ThrowStatement(factory.createPropertyAccessExpression(errorRecord, factory.createIdentifier('error'))),
        ),
        undefined,
      ),
    );
    context.addEmitFlags(rethrow, EmitFlags.SingleLine);
    const innerFinally = factory.createBlock([rethrow], false);
    context.addEmitFlags(innerFinally, EmitFlags.SingleLine);
    const innerTry = factory.created(new TryStatement(factory.createBlock([close], false), undefined, innerFinally));
    return factory.created(new TryStatement(tryBlock, catchClause, factory.createBlock([innerTry], true)));
  }

  // Functions

  private visitConstructor(node: ConstructorDeclaration): Node {
    const saved = this.enclosingFunctionFlags;
    this.enclosingFunctionFlags = getFunctionFlags(node);
    const updated = this.factory.updateConstructorDeclaration(
      node,
      node.modifiers,
      undefined,
      this.visitParameters(node.parameters)!,
      undefined,
      undefined,
      this.visitFunctionBody(node.body),
    );
    this.enclosingFunctionFlags = saved;
    return updated;
  }

  private visitGetAccessor(node: GetAccessorDeclaration): Node {
    const saved = this.enclosingFunctionFlags;
    this.enclosingFunctionFlags = getFunctionFlags(node);
    const updated = this.factory.updateGetAccessorDeclaration(
      node,
      node.modifiers,
      this.visitNode(node.name)!,
      undefined,
      this.visitParameters(node.parameters)!,
      undefined,
      undefined,
      this.visitFunctionBody(node.body),
    );
    this.enclosingFunctionFlags = saved;
    return updated;
  }

  private visitSetAccessor(node: SetAccessorDeclaration): Node {
    const saved = this.enclosingFunctionFlags;
    this.enclosingFunctionFlags = getFunctionFlags(node);
    const updated = this.factory.updateSetAccessorDeclaration(
      node,
      node.modifiers,
      this.visitNode(node.name)!,
      undefined,
      this.visitParameters(node.parameters)!,
      undefined,
      undefined,
      this.visitFunctionBody(node.body),
    );
    this.enclosingFunctionFlags = saved;
    return updated;
  }

  /** Modifiers without `async` for generators, whose `async` moves to `__asyncGenerator`. */
  private generatorModifiers(modifiers: ModifierList | undefined): ModifierList | undefined {
    if ((this.enclosingFunctionFlags & FunctionFlags.Generator) === 0) return modifiers;
    return this.extractModifiers(modifiers, ~ModifierFlags.Async);
  }

  private visitMethodDeclaration(node: MethodDeclaration): Node {
    const saved = this.enclosingFunctionFlags;
    this.enclosingFunctionFlags = getFunctionFlags(node);
    const modifiers = this.generatorModifiers(node.modifiers);
    const asteriskToken = (this.enclosingFunctionFlags & FunctionFlags.Async) !== 0 ? undefined : node.asteriskToken;
    let parameters: NodeList;
    let body: Node | undefined;
    if (this.inAsyncGenerator()) {
      parameters = this.transformAsyncGeneratorParameterList(node);
      body = this.transformAsyncGeneratorBody(node);
    } else {
      parameters = this.visitParameters(node.parameters)!;
      body = this.visitFunctionBody(node.body);
    }
    const updated = this.factory.updateMethodDeclaration(
      node,
      modifiers,
      asteriskToken,
      this.visitNode(node.name)!,
      undefined,
      undefined,
      parameters,
      undefined,
      undefined,
      body,
    );
    this.enclosingFunctionFlags = saved;
    return updated;
  }

  private visitFunctionDeclaration(node: FunctionDeclaration): Node {
    const saved = this.enclosingFunctionFlags;
    this.enclosingFunctionFlags = getFunctionFlags(node);
    const modifiers = this.generatorModifiers(node.modifiers);
    const asteriskToken = (this.enclosingFunctionFlags & FunctionFlags.Async) !== 0 ? undefined : node.asteriskToken;
    let parameters: NodeList;
    let body: Node | undefined;
    if (this.inAsyncGenerator()) {
      parameters = this.transformAsyncGeneratorParameterList(node);
      body = this.transformAsyncGeneratorBody(node);
    } else {
      parameters = this.visitParameters(node.parameters)!;
      body = this.visitFunctionBody(node.body);
    }
    const updated = this.factory.updateFunctionDeclaration(
      node,
      modifiers,
      asteriskToken,
      node.name,
      undefined,
      parameters,
      undefined,
      undefined,
      body,
    );
    this.enclosingFunctionFlags = saved;
    return updated;
  }

  private visitFunctionExpression(node: FunctionExpression): Node {
    const saved = this.enclosingFunctionFlags;
    this.enclosingFunctionFlags = getFunctionFlags(node);
    const modifiers = this.generatorModifiers(node.modifiers);
    const asteriskToken = (this.enclosingFunctionFlags & FunctionFlags.Async) !== 0 ? undefined : node.asteriskToken;
    let parameters: NodeList;
    let body: Node;
    if (this.inAsyncGenerator()) {
      parameters = this.transformAsyncGeneratorParameterList(node);
      body = this.transformAsyncGeneratorBody(node);
    } else {
      parameters = this.visitParameters(node.parameters)!;
      body = this.visitFunctionBody(node.body)!;
    }
    const updated = this.factory.updateFunctionExpression(
      node,
      modifiers,
      asteriskToken,
      node.name,
      undefined,
      parameters,
      undefined,
      undefined,
      body,
    );
    this.enclosingFunctionFlags = saved;
    return updated;
  }

  private visitArrowFunction(node: ArrowFunction): Node {
    const saved = this.enclosingFunctionFlags;
    this.enclosingFunctionFlags = getFunctionFlags(node);
    const updated = this.factory.updateArrowFunction(
      node,
      node.modifiers,
      undefined,
      this.visitParameters(node.parameters)!,
      undefined,
      undefined,
      node.equalsGreaterThanToken,
      this.visitFunctionBody(node.body)!,
    );
    this.enclosingFunctionFlags = saved;
    return updated;
  }

  /** The visited parameters if simple, else placeholders up to the first initializer or rest, keeping `length`. */
  private transformAsyncGeneratorParameterList(node: Node): NodeList {
    const list = getParameters(node)!;
    if (isSimpleParameterList(list.nodes)) return this.visitParameters(list)!;
    const factory = this.factory;
    const parameters: Node[] = [];
    for (let i = 0; i < list.nodes.length; i++) {
      const parameter = list.nodes[i] as ParameterDeclaration;
      if (parameter.initializer !== undefined || parameter.dotDotDotToken !== undefined) break;
      parameters.push(
        factory.createParameter(
          factory.createGeneratedNameForNode(parameter.name, GeneratedIdentifierFlags.ReservedInNestedScopes, '', ''),
        ),
      );
    }
    const result = factory.createNodeList(parameters);
    result.pos = list.pos;
    result.end = list.end;
    return result;
  }

  private transformAsyncGeneratorBody(node: Node): Node {
    const factory = this.factory;
    const context = this.context;
    const superAccess = this.superAccess;
    const parameterList = getParameters(node)!;
    const innerParameters = isSimpleParameterList(parameterList.nodes)
      ? undefined
      : this.visitParameters(parameterList);
    const saved = superAccess.enter();
    const body = getBody(node) as Block;
    let asyncBody = factory.updateBlock(body, this.visitNodes(body.statements)!, body.multiLine);
    asyncBody = factory.updateBlock(
      asyncBody,
      context.mergeEnvironmentList(asyncBody.statements, context.endVariableEnvironment()),
      asyncBody.multiLine,
    );
    const emitSuperHelpers = superAccess.needsHelpers();
    if (emitSuperHelpers) asyncBody = superAccess.visitNode(asyncBody) as Block;
    const name = getName(node);
    const generator = factory.created(
      new FunctionExpression(
        undefined,
        factory.createToken(SyntaxKind.AsteriskToken),
        name !== undefined
          ? factory.createGeneratedNameForNode(name, GeneratedIdentifierFlags.None, '', '')
          : undefined,
        undefined,
        innerParameters !== undefined ? innerParameters : factory.createNodeList([]),
        undefined,
        undefined,
        asyncBody as Node,
      ),
    );
    const returnStatement = factory.createReturnStatement(
      createAsyncGeneratorHelper(factory, generator, (this.hierarchyFacts & HierarchyFacts.HasLexicalThis) !== 0),
    );
    context.startVariableEnvironment();
    if (emitSuperHelpers && superAccess.capturedSuperProperties!.length > 0)
      context.addInitializationStatement(superAccess.createSuperAccessVariableStatement());
    const block = factory.updateBlock(
      body,
      factory.createNodeList(context.mergeEnvironment([returnStatement], context.endVariableEnvironment())),
      body.multiLine,
    );
    if (emitSuperHelpers && superAccess.hasSuperElementAccess)
      context.addEmitHelper(
        block,
        superAccess.hasSuperPropertyAssignment ? advancedAsyncSuperHelper : asyncSuperHelper,
      );
    superAccess.exit(saved);
    return block;
  }
}
