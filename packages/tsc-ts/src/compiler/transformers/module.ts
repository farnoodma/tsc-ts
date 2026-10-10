// `"use strict"` prologues and module output: ECMAScript modules, CommonJS, or each file in the
// format its extension and package.json imply.
import {
  CallExpression,
  ExportAssignment,
  ExportDeclaration,
  ExportSpecifier,
  ExpressionStatement,
  ExternalModuleReference,
  ImportAttributes,
  ImportClause,
  ImportDeclaration,
  ImportEqualsDeclaration,
  ImportSpecifier,
  MetaProperty,
  ModifierFlags,
  NamedExports,
  NamedImports,
  NamespaceExport,
  NamespaceImport,
  type Node,
  NodeFlags,
  NodeList,
  ScriptKind,
  SourceFile,
  StringLiteral,
  NoSubstitutionTemplateLiteral,
  Identifier,
} from '../ast.js';
import { isAnyImportOrReExport, isImportCall, isInJSFile, isRequireCall } from '../ast-utilities.js';
import { type CompilerOptions, JsxEmit, ModuleKind, getEmitModuleKind, getIsolatedModules } from '../options.js';
import type { EmitContext } from '../printer/emit-context.js';
import { EmitFlags, GeneratedIdentifierFlags } from '../printer/emit-flags.js';
import { isPrologueDirective } from '../printer/utilities.js';
import { SyntaxKind } from '../syntax-kind.js';
import { TokenFlags } from '../types.js';
import { CommonJSModuleTransformer } from './commonjs-module.js';
import type { EmitResolver } from './emit-resolver.js';
import { createExternalHelpersImportDeclarationIfNeeded } from './external-module-info.js';
import { createRequireCallArguments, rewriteModuleSpecifier } from './module-utilities.js';
import { Transformer } from './transformer.js';
import { hasSyntacticModifier, isExternalModule, singleOrMany } from './utilities.js';

/** Decides the module format each file is emitted in, from its extension and the nearest package.json. */
export abstract class ModuleFormatHost {
  abstract getEmitModuleFormat(fileName: string): ModuleKind;
}

export class UseStrictTransformer extends Transformer {
  readonly options: CompilerOptions;
  readonly formats: ModuleFormatHost;

  constructor(context: EmitContext, options: CompilerOptions, formats: ModuleFormatHost) {
    super(context);
    this.options = options;
    this.formats = formats;
  }

  visit(node: Node): Node | undefined {
    if (!(node instanceof SourceFile) || node.scriptKind === ScriptKind.JSON) return node;
    const moduleKind = getEmitModuleKind(this.options);
    // ES modules are always strict.
    if (
      isExternalModule(node) &&
      moduleKind >= ModuleKind.ES2015 &&
      (moduleKind === ModuleKind.Preserve || this.formats.getEmitModuleFormat(node.fileName) >= ModuleKind.ES2015)
    )
      return node;
    const statements = node.statements.nodes;
    const first = statements.length > 0 ? statements[0] : undefined;
    if (
      first instanceof ExpressionStatement &&
      first.expression instanceof StringLiteral &&
      first.expression.text === 'use strict'
    )
      return node;
    const factory = this.factory;
    const useStrict = factory.createExpressionStatement(factory.createStringLiteral('use strict', TokenFlags.None));
    return factory.updateSourceFile(
      node,
      new NodeList(node.statements.pos, node.statements.end, [useStrict as Node].concat(statements)),
      node.endOfFileToken,
    );
  }
}

/** The module transform for `module`: ES modules, CommonJS, or the format each file implies. */
export function createModuleTransformer(
  context: EmitContext,
  options: CompilerOptions,
  resolver: EmitResolver,
  formats: ModuleFormatHost,
): Transformer {
  switch (getEmitModuleKind(options)) {
    case ModuleKind.Preserve:
      // ES module output also keeps CommonJS syntax for `module: preserve`.
      return new ESModuleTransformer(context, options, formats);
    case ModuleKind.ESNext:
    case ModuleKind.ES2022:
    case ModuleKind.ES2020:
    case ModuleKind.ES2015:
    case ModuleKind.Node20:
    case ModuleKind.Node18:
    case ModuleKind.Node16:
    case ModuleKind.NodeNext:
    case ModuleKind.CommonJS:
      return new ImpliedModuleTransformer(context, options, resolver, formats);
  }
  return new CommonJSModuleTransformer(context, options, resolver, formats);
}

/** Emits each file as an ES module or as CommonJS, by its format. */
export class ImpliedModuleTransformer extends Transformer {
  readonly options: CompilerOptions;
  readonly resolver: EmitResolver;
  readonly formats: ModuleFormatHost;
  private esm: ESModuleTransformer | undefined;
  private commonjs: CommonJSModuleTransformer | undefined;

  constructor(context: EmitContext, options: CompilerOptions, resolver: EmitResolver, formats: ModuleFormatHost) {
    super(context);
    this.options = options;
    this.resolver = resolver;
    this.formats = formats;
    this.esm = undefined;
    this.commonjs = undefined;
  }

  visit(node: Node): Node | undefined {
    if (!(node instanceof SourceFile) || node.isDeclarationFile) return node;
    if (this.formats.getEmitModuleFormat(node.fileName) >= ModuleKind.ES2015) {
      if (this.esm === undefined) this.esm = new ESModuleTransformer(this.context, this.options, this.formats);
      return this.esm.transformSourceFile(node);
    }
    if (this.commonjs === undefined)
      this.commonjs = new CommonJSModuleTransformer(this.context, this.options, this.resolver, this.formats);
    return this.commonjs.transformSourceFile(node);
  }
}

/** ECMAScript module output: drops or rewrites `import x = require()` and `export =`, and keeps files modules. */
export class ESModuleTransformer extends Transformer {
  readonly options: CompilerOptions;
  readonly formats: ModuleFormatHost;
  private currentSourceFile: SourceFile | undefined;
  /** `import { createRequire } from "module"` and `const __require = ...`, once a file needs them. */
  private requireStatements: Node[] | undefined;
  private requireHelperName: Identifier | undefined;

  constructor(context: EmitContext, options: CompilerOptions, formats: ModuleFormatHost) {
    super(context);
    this.options = options;
    this.formats = formats;
    this.currentSourceFile = undefined;
    this.requireStatements = undefined;
    this.requireHelperName = undefined;
  }

  visit(node: Node): Node | undefined {
    switch (node.kind) {
      case SyntaxKind.SourceFile:
        if (node instanceof SourceFile) return this.visitSourceFile(node);
        break;
      case SyntaxKind.ImportDeclaration:
        if (node instanceof ImportDeclaration) return this.visitImportDeclaration(node);
        break;
      case SyntaxKind.ImportEqualsDeclaration:
        if (node instanceof ImportEqualsDeclaration) return this.visitImportEqualsDeclaration(node);
        break;
      case SyntaxKind.ExportAssignment:
        if (node instanceof ExportAssignment) return this.visitExportAssignment(node);
        break;
      case SyntaxKind.ExportDeclaration:
        if (node instanceof ExportDeclaration) return this.visitExportDeclaration(node);
        break;
      case SyntaxKind.CallExpression:
        if (node instanceof CallExpression) return this.visitCallExpression(node);
        break;
    }
    return this.visitEachChild(node);
  }

  private visitSourceFile(node: SourceFile): Node {
    if (node.isDeclarationFile || !(isExternalModule(node) || getIsolatedModules(this.options))) return node;
    const factory = this.factory;
    const context = this.context;
    this.currentSourceFile = node;
    this.requireStatements = undefined;
    this.requireHelperName = undefined;
    const visited = this.visitEachChild(node);
    let result = visited instanceof SourceFile ? visited : node;
    const helpers = context.readEmitHelpers();
    for (let i = 0; i < helpers.length; i++) context.addEmitHelper(result, helpers[i]);
    const helpersImport = createExternalHelpersImportDeclarationIfNeeded(
      context,
      result,
      this.options,
      this.formats.getEmitModuleFormat(node.fileName),
    );
    const requireStatements = this.getRequireStatements();
    if (helpersImport !== undefined || requireStatements !== undefined) {
      const current = result.statements.nodes;
      let end = 0;
      while (end < current.length && isPrologueDirective(current[end])) end++;
      while (
        end < current.length &&
        !isPrologueDirective(current[end]) &&
        (context.getEmitFlags(current[end]) & EmitFlags.CustomPrologue) !== 0
      )
        end++;
      const statements = current.slice(0, end);
      if (helpersImport !== undefined) {
        // Visited so that `import tslib = require("tslib")` becomes `const tslib = require("tslib")`.
        const visitedImport = this.visitNode(helpersImport);
        if (visitedImport !== undefined) statements.push(visitedImport);
      }
      if (requireStatements !== undefined)
        for (let i = 0; i < requireStatements.length; i++) statements.push(requireStatements[i]);
      for (let i = end; i < current.length; i++) statements.push(current[i]);
      result = factory.updateSourceFile(
        result,
        new NodeList(result.statements.pos, result.statements.end, statements),
        node.endOfFileToken,
      );
    }
    if (isExternalModule(result) && getEmitModuleKind(this.options) !== ModuleKind.Preserve) {
      const statements = result.statements.nodes;
      let hasIndicator = false;
      for (let i = 0; i < statements.length && !hasIndicator; i++)
        hasIndicator = isExternalModuleIndicator(statements[i]);
      if (!hasIndicator) {
        const emptyExport: Node = factory.created(
          new ExportDeclaration(
            undefined,
            false,
            factory.created(new NamedExports(factory.createNodeList([]))),
            undefined,
            undefined,
          ),
        );
        result = factory.updateSourceFile(
          result,
          new NodeList(result.statements.pos, result.statements.end, statements.concat([emptyExport])),
          node.endOfFileToken,
        );
      }
    }
    this.requireStatements = undefined;
    this.requireHelperName = undefined;
    this.currentSourceFile = undefined;
    return result;
  }

  /** The statements declaring `__require`, if the file needed them. */
  private getRequireStatements(): Node[] | undefined {
    return this.requireStatements;
  }

  private visitImportDeclaration(node: ImportDeclaration): Node {
    if (this.options.rewriteRelativeImportExtensions !== true) return node;
    const clause = this.visitNode(node.importClause);
    return this.factory.updateImportDeclaration(
      node,
      undefined,
      clause instanceof ImportClause ? clause : undefined,
      rewriteModuleSpecifier(this.context, node.moduleSpecifier, this.options),
      this.importAttributes(node.attributes),
    );
  }

  /** In node16+ ES modules, `import x = require("m")` becomes a call of a `createRequire` require. */
  private visitImportEqualsDeclaration(node: ImportEqualsDeclaration): Node | undefined {
    if (getEmitModuleKind(this.options) < ModuleKind.Node16) return undefined;
    if (!(node.moduleReference instanceof ExternalModuleReference)) return node;
    const factory = this.factory;
    const statement = factory.createVariableStatement(
      undefined,
      factory.createVariableDeclarationList(
        factory.createNodeList([
          factory.createVariableDeclaration(
            factory.cloneIdentifier(node.name),
            undefined,
            undefined,
            this.createRequireCall(node),
          ),
        ]),
        NodeFlags.Const,
      ),
    );
    this.context.setOriginal(statement, node);
    this.context.assignCommentAndSourceMapRanges(statement, node);
    const statements: Node[] = [statement];
    if (hasSyntacticModifier(node, ModifierFlags.Export))
      statements.push(
        factory.created(
          new ExportDeclaration(
            undefined,
            false,
            factory.created(
              new NamedExports(
                factory.createNodeList([
                  factory.created(new ExportSpecifier(false, undefined, factory.cloneIdentifier(node.name))),
                ]),
              ),
            ),
            undefined,
            undefined,
          ),
        ),
      );
    return singleOrMany(statements, factory);
  }

  private visitExportAssignment(node: ExportAssignment): Node | undefined {
    if (!node.isExportEquals) return this.visitEachChild(node);
    // `export =` isn't valid in ES modules; `module: preserve` keeps it as CommonJS.
    if (getEmitModuleKind(this.options) !== ModuleKind.Preserve) return undefined;
    const factory = this.factory;
    const statement = factory.createExpressionStatement(
      factory.createAssignment(
        factory.createPropertyAccessExpression(factory.createIdentifier('module'), factory.createIdentifier('exports')),
        this.visitNode(node.expression)!,
      ),
    );
    this.context.setOriginal(statement, node);
    return statement;
  }

  private visitExportDeclaration(node: ExportDeclaration): Node | undefined {
    if (node.moduleSpecifier === undefined) return node;
    const factory = this.factory;
    const specifier = rewriteModuleSpecifier(this.context, node.moduleSpecifier, this.options);
    const clause = node.exportClause;
    const module = this.options.module;
    if ((module !== undefined && module > ModuleKind.ES2015) || !(clause instanceof NamespaceExport))
      return factory.updateExportDeclaration(
        node,
        undefined,
        false,
        clause,
        specifier,
        this.importAttributes(node.attributes),
      );
    // ES2015 has no `export * as ns`: import the namespace and export it.
    const name = clause.name;
    const generated = factory.createGeneratedNameForNode(name, 0, '', '');
    const importDeclaration = factory.created(
      new ImportDeclaration(
        SyntaxKind.ImportDeclaration,
        undefined,
        factory.created(new ImportClause(undefined, undefined, factory.created(new NamespaceImport(generated)))),
        specifier,
        this.importAttributes(node.attributes),
      ),
    );
    this.context.setOriginal(importDeclaration, clause);
    const exportDeclaration: Node =
      name instanceof Identifier && name.text === 'default'
        ? factory.created(new ExportAssignment(undefined, false, undefined, generated))
        : factory.created(
            new ExportDeclaration(
              undefined,
              false,
              factory.created(
                new NamedExports(
                  factory.createNodeList([factory.created(new ExportSpecifier(false, generated, name))]),
                ),
              ),
              undefined,
              undefined,
            ),
          );
    this.context.setOriginal(exportDeclaration, node);
    return singleOrMany([importDeclaration, exportDeclaration], factory);
  }

  private visitCallExpression(node: CallExpression): Node {
    const args = node.arguments.nodes;
    if (
      this.options.rewriteRelativeImportExtensions !== true ||
      args.length === 0 ||
      !(isImportCall(node) || (isInJSFile(node) && isRequireCall(node, false)))
    )
      return this.visitEachChild(node);
    const factory = this.factory;
    const first = args[0];
    const argument =
      first instanceof StringLiteral || first instanceof NoSubstitutionTemplateLiteral
        ? rewriteModuleSpecifier(this.context, first, this.options)
        : factory.createRewriteRelativeImportExtensionsHelper(first, this.options.jsx === JsxEmit.Preserve);
    const rest = this.visitArray(args.slice(1));
    return factory.updateCallExpression(
      node,
      this.visitNode(node.expression)!,
      node.questionDotToken,
      undefined,
      new NodeList(node.arguments.pos, node.arguments.end, [argument].concat(rest)),
      node.flags,
    );
  }

  private importAttributes(node: ImportAttributes | undefined): ImportAttributes | undefined {
    const visited = this.visitNode(node);
    return visited instanceof ImportAttributes ? visited : undefined;
  }

  private createRequireCall(node: Node): Node {
    const factory = this.factory;
    const args = createRequireCallArguments(this.context, node, this.options);
    if (getEmitModuleKind(this.options) === ModuleKind.Preserve)
      return factory.createCallExpression(factory.createIdentifier('require'), args);
    let helperName = this.requireHelperName;
    if (helperName === undefined) {
      const flags = GeneratedIdentifierFlags.Optimistic | GeneratedIdentifierFlags.FileLevel;
      // import { createRequire as _createRequire } from "module";
      const createRequireName = factory.createUniqueName('_createRequire', flags);
      const importStatement = factory.created(
        new ImportDeclaration(
          SyntaxKind.ImportDeclaration,
          undefined,
          factory.created(
            new ImportClause(
              undefined,
              undefined,
              factory.created(
                new NamedImports(
                  factory.createNodeList([
                    factory.created(
                      new ImportSpecifier(false, factory.createIdentifier('createRequire'), createRequireName),
                    ),
                  ]),
                ),
              ),
            ),
          ),
          factory.createStringLiteral('module', TokenFlags.None),
          undefined,
        ),
      );
      this.context.addEmitFlags(importStatement, EmitFlags.CustomPrologue);
      // const __require = _createRequire(import.meta.url);
      helperName = factory.createUniqueName('__require', flags);
      const requireStatement = factory.createVariableStatement(
        undefined,
        factory.createVariableDeclarationList(
          factory.createNodeList([
            factory.createVariableDeclaration(
              helperName,
              undefined,
              undefined,
              factory.createCallExpression(factory.cloneIdentifier(createRequireName), [
                factory.createPropertyAccessExpression(
                  factory.created(new MetaProperty(SyntaxKind.ImportKeyword, factory.createIdentifier('meta'))),
                  factory.createIdentifier('url'),
                ),
              ]),
            ),
          ]),
          NodeFlags.Const,
        ),
      );
      this.context.addEmitFlags(requireStatement, EmitFlags.CustomPrologue);
      this.requireStatements = [importStatement, requireStatement];
      this.requireHelperName = helperName;
    }
    return factory.createCallExpression(factory.cloneIdentifier(helperName), args);
  }
}

function isExternalModuleIndicator(node: Node): boolean {
  return (
    isAnyImportOrReExport(node) || node instanceof ExportAssignment || hasSyntacticModifier(node, ModifierFlags.Export)
  );
}
