// Syntax queries the binder, name resolver and checker share, ported from tsgo's ast and
// scanner utilities.
import {
  BinaryExpression,
  BindingElement,
  CallExpression,
  ElementAccessExpression,
  ExportDeclaration,
  ExpressionStatement,
  Identifier,
  JSDoc,
  JSDocSatisfiesTag,
  JsxNamespacedName,
  MetaProperty,
  ModifierFlags,
  ModuleDeclaration,
  type Node,
  NodeFlags,
  NodeVisitor,
  PostfixUnaryExpression,
  PrefixUnaryExpression,
  ParenthesizedExpression,
  PropertyAccessExpression,
  QualifiedName,
  SatisfiesExpression,
  ScriptKind,
  type SourceFile,
  TaggedTemplateExpression,
  TypeReferenceNode,
  VariableDeclaration,
  VariableStatement,
  getArguments,
  getAsteriskToken,
  getBody,
  getElements,
  getExpression,
  getInitializer,
  getMembers,
  getModifiers,
  getName,
  getProperties,
  getPropertyName,
  getStatements,
  getTagName,
  getText,
  getType,
} from './ast.js';
import { getJSDoc } from './parser.js';
import { isAssignmentOperator, isLeftHandSideExpression, isStringLiteralLike, nodeIsMissing } from './ast-utilities.js';
import { Scanner, computeLineOfPosition, skipTrivia } from './scanner.js';
import { SyntaxKind } from './syntax-kind.js';
import { InternalSymbolName, type Symbol } from './symbol.js';

// Modifiers and flags

export function getModifierFlags(node: Node): ModifierFlags {
  const modifiers = getModifiers(node);
  return modifiers === undefined ? ModifierFlags.None : modifiers.modifierFlags;
}

export function hasSyntacticModifier(node: Node, flags: ModifierFlags): boolean {
  return (getModifierFlags(node) & flags) !== 0;
}

export function hasStaticModifier(node: Node): boolean {
  return hasSyntacticModifier(node, ModifierFlags.Static);
}

/** The declaration a binding element belongs to. */
export function getRootDeclaration(node: Node): Node {
  let current = node;
  while (current.kind === SyntaxKind.BindingElement) current = current.parent!.parent!;
  return current;
}

/** Modifier flags of a variable declaration combined with its list's and statement's. */
export function getCombinedModifierFlags(node: Node): ModifierFlags {
  let current: Node | undefined = getRootDeclaration(node);
  let flags = getModifierFlags(current);
  if (current.kind === SyntaxKind.VariableDeclaration) current = current.parent;
  if (current !== undefined && current.kind === SyntaxKind.VariableDeclarationList) {
    flags |= getModifierFlags(current);
    current = current.parent;
  }
  if (current !== undefined && current.kind === SyntaxKind.VariableStatement) flags |= getModifierFlags(current);
  return flags;
}

/** Node flags of a variable declaration combined with its list's and statement's. */
export function getCombinedNodeFlags(node: Node): NodeFlags {
  let current: Node | undefined = getRootDeclaration(node);
  let flags = current.flags;
  if (current.kind === SyntaxKind.VariableDeclaration) current = current.parent;
  if (current !== undefined && current.kind === SyntaxKind.VariableDeclarationList) {
    flags |= current.flags;
    current = current.parent;
  }
  if (current !== undefined && current.kind === SyntaxKind.VariableStatement) flags |= current.flags;
  return flags;
}

export function isEnumConst(node: Node): boolean {
  return (getCombinedModifierFlags(node) & ModifierFlags.Const) !== 0;
}

// Source files

export function isExternalModule(file: SourceFile): boolean {
  return file.externalModuleIndicator !== undefined;
}

export function isExternalOrCommonJSModule(file: SourceFile): boolean {
  return file.externalModuleIndicator !== undefined || file.commonJSModuleIndicator !== undefined;
}

export function isJsonSourceFile(file: SourceFile): boolean {
  return file.scriptKind === ScriptKind.JSON;
}

/** A source file whose declarations are global. */
export function isGlobalSourceFile(node: Node): boolean {
  return node.kind === SyntaxKind.SourceFile && !isExternalOrCommonJSModule(node as SourceFile);
}

export function getSourceFileOfNode(node: Node): SourceFile {
  while (node.parent !== undefined) node = node.parent;
  return node as SourceFile;
}

// Kinds

export function isClassLike(node: Node): boolean {
  return node.kind === SyntaxKind.ClassDeclaration || node.kind === SyntaxKind.ClassExpression;
}

export function isClassElement(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.Constructor:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.IndexSignature:
    case SyntaxKind.ClassStaticBlockDeclaration:
    case SyntaxKind.SemicolonClassElement:
      return true;
  }
  return false;
}

/** As the spec's IsStatic: a static class element or a static block. */
export function isStatic(node: Node): boolean {
  return (isClassElement(node) && hasStaticModifier(node)) || node.kind === SyntaxKind.ClassStaticBlockDeclaration;
}

export function isDeclarationStatementKind(kind: SyntaxKind): boolean {
  switch (kind) {
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.MissingDeclaration:
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.InterfaceDeclaration:
    case SyntaxKind.TypeAliasDeclaration:
    case SyntaxKind.JSTypeAliasDeclaration:
    case SyntaxKind.EnumDeclaration:
    case SyntaxKind.ModuleDeclaration:
    case SyntaxKind.ImportDeclaration:
    case SyntaxKind.JSImportDeclaration:
    case SyntaxKind.ImportEqualsDeclaration:
    case SyntaxKind.ExportDeclaration:
    case SyntaxKind.ExportAssignment:
    case SyntaxKind.NamespaceExportDeclaration:
      return true;
  }
  return false;
}

export function isTypeNodeKind(kind: SyntaxKind): boolean {
  switch (kind) {
    case SyntaxKind.AnyKeyword:
    case SyntaxKind.UnknownKeyword:
    case SyntaxKind.NumberKeyword:
    case SyntaxKind.BigIntKeyword:
    case SyntaxKind.ObjectKeyword:
    case SyntaxKind.BooleanKeyword:
    case SyntaxKind.StringKeyword:
    case SyntaxKind.SymbolKeyword:
    case SyntaxKind.VoidKeyword:
    case SyntaxKind.UndefinedKeyword:
    case SyntaxKind.NeverKeyword:
    case SyntaxKind.IntrinsicKeyword:
    case SyntaxKind.ExpressionWithTypeArguments:
    case SyntaxKind.JSDocAllType:
    case SyntaxKind.JSDocNullableType:
    case SyntaxKind.JSDocNonNullableType:
    case SyntaxKind.JSDocOptionalType:
    case SyntaxKind.JSDocVariadicType:
      return true;
  }
  return kind >= SyntaxKind.FirstTypeNode && kind <= SyntaxKind.LastTypeNode;
}

export function isFunctionExpressionOrArrowFunction(node: Node): boolean {
  return node.kind === SyntaxKind.FunctionExpression || node.kind === SyntaxKind.ArrowFunction;
}

export function isMethodOrAccessor(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
      return true;
  }
  return false;
}

export function isObjectLiteralOrClassExpressionMethodOrAccessor(node: Node): boolean {
  if (!isMethodOrAccessor(node)) return false;
  const parentKind = node.parent!.kind;
  return parentKind === SyntaxKind.ObjectLiteralExpression || parentKind === SyntaxKind.ClassExpression;
}

export function isObjectLiteralMethod(node: Node | undefined): boolean {
  return (
    node !== undefined &&
    node.kind === SyntaxKind.MethodDeclaration &&
    node.parent!.kind === SyntaxKind.ObjectLiteralExpression
  );
}

export function isAutoAccessorPropertyDeclaration(node: Node): boolean {
  return node.kind === SyntaxKind.PropertyDeclaration && hasSyntacticModifier(node, ModifierFlags.Accessor);
}

export function isParameterPropertyDeclaration(node: Node, parent: Node): boolean {
  return (
    node.kind === SyntaxKind.Parameter &&
    hasSyntacticModifier(node, ModifierFlags.ParameterPropertyModifier) &&
    parent.kind === SyntaxKind.Constructor
  );
}

export function isPrivateIdentifierClassElementDeclaration(node: Node): boolean {
  if (node.kind !== SyntaxKind.PropertyDeclaration && !isMethodOrAccessor(node)) return false;
  const name = getName(node);
  return name !== undefined && name.kind === SyntaxKind.PrivateIdentifier;
}

export function isAsyncFunction(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.MethodDeclaration:
      return (
        getBody(node) !== undefined &&
        getAsteriskToken(node) === undefined &&
        hasSyntacticModifier(node, ModifierFlags.Async)
      );
  }
  return false;
}

export function isStringOrNumericLiteralLike(node: Node): boolean {
  return isStringLiteralLike(node) || node.kind === SyntaxKind.NumericLiteral;
}

export function isSignedNumericLiteral(node: Node): boolean {
  return (
    node instanceof PrefixUnaryExpression &&
    (node.operator === SyntaxKind.PlusToken || node.operator === SyntaxKind.MinusToken) &&
    node.operand.kind === SyntaxKind.NumericLiteral
  );
}

export function isPropertyNameLiteral(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.Identifier:
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
    case SyntaxKind.NumericLiteral:
      return true;
  }
  return false;
}

export function isBooleanLiteral(node: Node): boolean {
  return node.kind === SyntaxKind.TrueKeyword || node.kind === SyntaxKind.FalseKeyword;
}

export function isPrologueDirective(node: Node): boolean {
  return node instanceof ExpressionStatement && node.expression.kind === SyntaxKind.StringLiteral;
}

/** The text of an identifier, literal, meta property or JSX namespaced name. */
export function nodeText(node: Node): string {
  if (node instanceof JsxNamespacedName) {
    const namespaced = node;
    return namespaced.namespace.text + ':' + namespaced.name.text;
  }
  if (node instanceof MetaProperty) return node.name.text;
  return getText(node);
}

export function isIdentifierNamed(node: Node, name: string): boolean {
  return node instanceof Identifier && node.text === name;
}

// Expressions

/** `node` without enclosing parentheses. */
export function skipParentheses(node: Node): Node {
  let current = node;
  while (current instanceof ParenthesizedExpression) current = current.expression;
  return current;
}

function getQuestionDotToken(node: Node): Node | undefined {
  if (
    node instanceof PropertyAccessExpression ||
    node instanceof ElementAccessExpression ||
    node instanceof CallExpression ||
    node instanceof TaggedTemplateExpression
  )
    return node.questionDotToken;
  return undefined;
}

export function isOptionalChain(node: Node): boolean {
  if ((node.flags & NodeFlags.OptionalChain) === 0) return false;
  switch (node.kind) {
    case SyntaxKind.PropertyAccessExpression:
    case SyntaxKind.ElementAccessExpression:
    case SyntaxKind.CallExpression:
    case SyntaxKind.NonNullExpression:
      return true;
  }
  return false;
}

/** The link of an optional chain with the `?.`. */
export function isOptionalChainRoot(node: Node): boolean {
  return isOptionalChain(node) && node.kind !== SyntaxKind.NonNullExpression && getQuestionDotToken(node) !== undefined;
}

/** Whether `node` is the whole optional chain, not a link in a longer one. */
export function isOutermostOptionalChain(node: Node): boolean {
  const parent = node.parent!;
  return !isOptionalChain(parent) || isOptionalChainRoot(parent) || node !== getExpression(parent);
}

export function isExpressionOfOptionalChainRoot(node: Node): boolean {
  const parent = node.parent!;
  return isOptionalChainRoot(parent) && getExpression(parent) === node;
}

export function isNullishCoalesce(node: Node): boolean {
  return node instanceof BinaryExpression && node.operatorToken.kind === SyntaxKind.QuestionQuestionToken;
}

export function isLogicalOrCoalescingBinaryOperator(kind: SyntaxKind): boolean {
  return (
    kind === SyntaxKind.BarBarToken ||
    kind === SyntaxKind.AmpersandAmpersandToken ||
    kind === SyntaxKind.QuestionQuestionToken
  );
}

export function isLogicalOrCoalescingAssignmentOperator(kind: SyntaxKind): boolean {
  return (
    kind === SyntaxKind.AmpersandAmpersandEqualsToken ||
    kind === SyntaxKind.BarBarEqualsToken ||
    kind === SyntaxKind.QuestionQuestionEqualsToken
  );
}

export function isLogicalOrCoalescingAssignmentExpression(node: Node): boolean {
  return node instanceof BinaryExpression && isLogicalOrCoalescingAssignmentOperator(node.operatorToken.kind);
}

/** `&&`, `||` or `??`, possibly parenthesized or negated. */
export function isLogicalExpression(node: Node): boolean {
  let current = node;
  for (;;) {
    if (current instanceof ParenthesizedExpression) {
      const parenthesized: ParenthesizedExpression = current;
      current = parenthesized.expression;
    } else if (current instanceof PrefixUnaryExpression) {
      const unary: PrefixUnaryExpression = current;
      if (unary.operator !== SyntaxKind.ExclamationToken) return false;
      current = unary.operand;
    } else if (current instanceof BinaryExpression) {
      const binary: BinaryExpression = current;
      return isLogicalOrCoalescingBinaryOperator(binary.operatorToken.kind);
    } else return false;
  }
}

export function isAssignmentExpression(node: Node, excludeCompoundAssignment: boolean): boolean {
  if (!(node instanceof BinaryExpression)) return false;
  const binary = node;
  const operator = binary.operatorToken.kind;
  return (
    (operator === SyntaxKind.EqualsToken || (!excludeCompoundAssignment && isAssignmentOperator(operator))) &&
    isLeftHandSideExpression(binary.left)
  );
}

/** `[a, b] = …` or `({ a } = …)`. */
export function isDestructuringAssignment(node: Node): boolean {
  if (!isAssignmentExpression(node, true)) return false;
  const kind = (node as BinaryExpression).left.kind;
  return kind === SyntaxKind.ObjectLiteralExpression || kind === SyntaxKind.ArrayLiteralExpression;
}

/** The assignment, update or `for…in`/`for…of` that writes to `node`, if any. */
export function getAssignmentTarget(node: Node): Node | undefined {
  let current = node;
  for (;;) {
    const parent = current.parent!;
    switch (parent.kind) {
      case SyntaxKind.BinaryExpression: {
        const binary = parent as BinaryExpression;
        return isAssignmentOperator(binary.operatorToken.kind) && binary.left === current ? parent : undefined;
      }
      case SyntaxKind.PrefixUnaryExpression: {
        const operator = (parent as PrefixUnaryExpression).operator;
        return operator === SyntaxKind.PlusPlusToken || operator === SyntaxKind.MinusMinusToken ? parent : undefined;
      }
      case SyntaxKind.PostfixUnaryExpression: {
        const operator = (parent as PostfixUnaryExpression).operator;
        return operator === SyntaxKind.PlusPlusToken || operator === SyntaxKind.MinusMinusToken ? parent : undefined;
      }
      case SyntaxKind.ForInStatement:
      case SyntaxKind.ForOfStatement:
        return getInitializer(parent) === current ? parent : undefined;
      case SyntaxKind.ParenthesizedExpression:
      case SyntaxKind.ArrayLiteralExpression:
      case SyntaxKind.SpreadElement:
      case SyntaxKind.NonNullExpression:
        current = parent;
        break;
      case SyntaxKind.SpreadAssignment:
        current = parent.parent!;
        break;
      case SyntaxKind.ShorthandPropertyAssignment:
        if (getName(parent) !== current) return undefined;
        current = parent.parent!;
        break;
      case SyntaxKind.PropertyAssignment:
        if (getName(parent) === current) return undefined;
        current = parent.parent!;
        break;
      default:
        return undefined;
    }
  }
}

export function isAssignmentTarget(node: Node): boolean {
  return getAssignmentTarget(node) !== undefined;
}

/** An identifier, `this`, `super` or `import.meta`, possibly with property accesses. */
export function isDottedName(node: Node): boolean {
  let current = node;
  for (;;) {
    switch (current.kind) {
      case SyntaxKind.Identifier:
      case SyntaxKind.ThisKeyword:
      case SyntaxKind.SuperKeyword:
      case SyntaxKind.MetaProperty:
        return true;
      case SyntaxKind.PropertyAccessExpression:
        current = (current as PropertyAccessExpression).expression;
        break;
      case SyntaxKind.ParenthesizedExpression:
        current = (current as ParenthesizedExpression).expression;
        break;
      default:
        return false;
    }
  }
}

/** `a`, `a.b.c`, and in JavaScript `this.a` and `a["b"]`. */
export function isEntityNameExpression(node: Node, allowJS: boolean): boolean {
  if (node.kind === SyntaxKind.Identifier) return true;
  if (node instanceof PropertyAccessExpression) {
    const access = node;
    return access.name.kind === SyntaxKind.Identifier && isEntityNameExpression(access.expression, allowJS);
  }
  if (!allowJS) return false;
  if (node.kind === SyntaxKind.ThisKeyword) return true;
  if (!(node instanceof ElementAccessExpression)) return false;
  const access = node;
  return isStringOrNumericLiteralLike(access.argumentExpression) && isEntityNameExpression(access.expression, allowJS);
}

/** An `export default` or `module.exports =` expression that aliases a declaration. */
export function expressionIsAlias(node: Node): boolean {
  return isEntityNameExpression(node, false) || node.kind === SyntaxKind.ClassExpression;
}

export function isAccessExpression(node: Node): boolean {
  return node.kind === SyntaxKind.PropertyAccessExpression || node.kind === SyntaxKind.ElementAccessExpression;
}

/** The name of `x.name` or the literal of `x["name"]`. */
export function getElementOrPropertyAccessName(node: Node): Node | undefined {
  if (node instanceof PropertyAccessExpression) return node.name.kind === SyntaxKind.Identifier ? node.name : undefined;
  if (node instanceof ElementAccessExpression) {
    const argument = skipParentheses(node.argumentExpression);
    return isStringOrNumericLiteralLike(argument) ? argument : undefined;
  }
  throw new Error('Unhandled case in getElementOrPropertyAccessName');
}

export function isPushOrUnshiftIdentifier(node: Node): boolean {
  const text = getText(node);
  return text === 'push' || text === 'unshift';
}

/** The call of an immediately invoked function or arrow function. */
export function getImmediatelyInvokedFunctionExpression(fn: Node): Node | undefined {
  if (!isFunctionExpressionOrArrowFunction(fn)) return undefined;
  let prev = fn;
  let parent = fn.parent!;
  while (parent.kind === SyntaxKind.ParenthesizedExpression) {
    prev = parent;
    parent = parent.parent!;
  }
  if (!(parent instanceof CallExpression)) return undefined;
  const call: CallExpression = parent;
  return call.expression === prev ? call : undefined;
}

/** `x as const` or `<const>x`. */
export function isConstAssertion(node: Node): boolean {
  if (node.kind !== SyntaxKind.AsExpression && node.kind !== SyntaxKind.TypeAssertionExpression) return false;
  const type = getType(node);
  if (!(type instanceof TypeReferenceNode)) return false;
  const typeArguments = type.typeArguments;
  return (typeArguments === undefined || typeArguments.nodes.length === 0) && isIdentifierNamed(type.typeName, 'const');
}

// JavaScript declarations

/** What a JavaScript assignment or `Object.defineProperty` call declares. */
export const enum JSDeclarationKind {
  None,
  /** `module.exports = expr` */
  ModuleExports,
  /** `exports.name = expr`, `module.exports.name = expr` */
  ExportsProperty,
  /** `this.name = expr` */
  ThisProperty,
  /** `F.name = expr`, `F[name] = expr` */
  Property,
  /** `Object.defineProperty(x, 'name', …)` */
  ObjectDefinePropertyValue,
  /** `Object.defineProperty(exports || module.exports, 'name', …)` */
  ObjectDefinePropertyExports,
}

export function isModuleIdentifier(node: Node): boolean {
  return isIdentifierNamed(node, 'module');
}

export function isExportsIdentifier(node: Node): boolean {
  return isIdentifierNamed(node, 'exports');
}

/** `module.exports` or `module["exports"]`. */
export function isModuleExportsAccessExpression(node: Node): boolean {
  if (!isAccessExpression(node) || !isModuleIdentifier(getExpression(node)!)) return false;
  const name = getElementOrPropertyAccessName(node);
  return name !== undefined && getText(name) === 'exports';
}

function isLiteralLikeElementAccess(node: Node): boolean {
  return node instanceof ElementAccessExpression && isStringOrNumericLiteralLike(node.argumentExpression);
}

export function isBindableStaticAccessExpression(node: Node, excludeThisKeyword: boolean): boolean {
  if (node instanceof PropertyAccessExpression) {
    if (!excludeThisKeyword && node.expression.kind === SyntaxKind.ThisKeyword) return true;
    if (node.name.kind === SyntaxKind.Identifier && isBindableStaticNameExpression(node.expression, true)) return true;
  }
  return isBindableStaticElementAccessExpression(node, excludeThisKeyword);
}

export function isBindableStaticElementAccessExpression(node: Node, excludeThisKeyword: boolean): boolean {
  if (!isLiteralLikeElementAccess(node)) return false;
  const expression = (node as ElementAccessExpression).expression;
  return (
    (!excludeThisKeyword && expression.kind === SyntaxKind.ThisKeyword) ||
    isEntityNameExpression(expression, false) ||
    isBindableStaticAccessExpression(expression, true)
  );
}

export function isBindableStaticNameExpression(node: Node, excludeThisKeyword: boolean): boolean {
  return isEntityNameExpression(node, false) || isBindableStaticAccessExpression(node, excludeThisKeyword);
}

/** `Object.defineProperty(x, "name", descriptor)` with a bindable `x`. */
export function isBindableObjectDefinePropertyCall(node: Node): boolean {
  if (!(node instanceof CallExpression)) return false;
  const args = node.arguments.nodes;
  if (args.length !== 3) return false;
  const callee = node.expression;
  return (
    callee instanceof PropertyAccessExpression &&
    isIdentifierNamed(callee.expression, 'Object') &&
    getText(callee.name) === 'defineProperty' &&
    isStringOrNumericLiteralLike(args[1]!) &&
    isBindableStaticNameExpression(args[0]!, true)
  );
}

export function getAssignmentDeclarationKind(node: Node): JSDeclarationKind {
  if (node instanceof BinaryExpression) {
    const binary = node;
    const left = binary.left;
    if (binary.operatorToken.kind !== SyntaxKind.EqualsToken || !isAccessExpression(left))
      return JSDeclarationKind.None;
    const inJS = (left.flags & NodeFlags.JavaScriptFile) !== 0;
    const target = getExpression(left)!;
    if (inJS) {
      if (isModuleExportsAccessExpression(left) && !isExportsIdentifier(binary.right))
        return JSDeclarationKind.ModuleExports;
      if (
        (isModuleExportsAccessExpression(target) || isExportsIdentifier(target)) &&
        getElementOrPropertyAccessName(left) !== undefined
      )
        return JSDeclarationKind.ExportsProperty;
      if (target.kind === SyntaxKind.ThisKeyword) return JSDeclarationKind.ThisProperty;
    }
    if (left instanceof PropertyAccessExpression) {
      if (isEntityNameExpression(target, inJS) && left.name.kind === SyntaxKind.Identifier)
        return JSDeclarationKind.Property;
    } else if (isEntityNameExpression(target, inJS)) return JSDeclarationKind.Property;
    return JSDeclarationKind.None;
  }
  if (
    node.kind === SyntaxKind.CallExpression &&
    (node.flags & NodeFlags.JavaScriptFile) !== 0 &&
    isBindableObjectDefinePropertyCall(node)
  ) {
    const entityName = getArguments(node)!.nodes[0]!;
    return isExportsIdentifier(entityName) || isModuleExportsAccessExpression(entityName)
      ? JSDeclarationKind.ObjectDefinePropertyExports
      : JSDeclarationKind.ObjectDefinePropertyValue;
  }
  return JSDeclarationKind.None;
}

/** A function, arrow or (in JavaScript) class expression or empty object literal that can get expando properties. */
export function isExpandoInitializer(declaration: Node, initializer: Node | undefined): boolean {
  if (initializer === undefined) return false;
  if (isFunctionExpressionOrArrowFunction(initializer)) return true;
  if ((initializer.flags & NodeFlags.JavaScriptFile) === 0) return false;
  if (initializer.kind === SyntaxKind.ClassExpression) return true;
  return (
    initializer.kind === SyntaxKind.ObjectLiteralExpression &&
    getProperties(initializer)!.nodes.length === 0 &&
    getType(declaration) === undefined
  );
}

/** `const x = require("m")` in JavaScript, or a binding element of one. */
export function isVariableDeclarationInitializedToRequire(node: Node): boolean {
  const candidate = node.kind === SyntaxKind.BindingElement ? node.parent!.parent! : node;
  if (!(candidate instanceof VariableDeclaration) || (candidate.flags & NodeFlags.JavaScriptFile) === 0) return false;
  const declaration = candidate;
  const initializer = declaration.initializer;
  if (initializer === undefined) return false;
  return (
    (getModifierFlags(declaration.parent!.parent!) & ModifierFlags.Export) === 0 &&
    declaration.type === undefined &&
    isRequireCallWithLiteral(initializer)
  );
}

function isRequireCallWithLiteral(node: Node): boolean {
  if (!(node instanceof CallExpression) || !isIdentifierNamed(node.expression, 'require')) return false;
  const args = node.arguments.nodes;
  return args.length === 1 && isStringLiteralLike(args[0]!);
}

/** A `@typedef` or `@callback` at the top level of a module. */
export function isImplicitlyExportedJSDocDeclaration(node: Node): boolean {
  const parent = node.parent!;
  if (parent.kind !== SyntaxKind.SourceFile || !isExternalOrCommonJSModule(parent as SourceFile)) return false;
  if (node.kind === SyntaxKind.JSTypeAliasDeclaration) return true;
  return node.kind === SyntaxKind.ModuleDeclaration && (node.flags & NodeFlags.Reparsed) !== 0;
}

// Declarations

/** The name of a declaration, not counting names it gets from an enclosing assignment. */
export function getNonAssignedNameOfDeclaration(declaration: Node): Node | undefined {
  switch (declaration.kind) {
    case SyntaxKind.BinaryExpression:
    case SyntaxKind.CallExpression:
      switch (getAssignmentDeclarationKind(declaration)) {
        case JSDeclarationKind.Property:
        case JSDeclarationKind.ThisProperty:
        case JSDeclarationKind.ExportsProperty: {
          const left = (declaration as BinaryExpression).left;
          const name = getElementOrPropertyAccessName(left);
          return name !== undefined ? name : left;
        }
        case JSDeclarationKind.ObjectDefinePropertyValue:
        case JSDeclarationKind.ObjectDefinePropertyExports:
          return getArguments(declaration)!.nodes[1]!;
      }
      return undefined;
    case SyntaxKind.ExportAssignment: {
      const expression = getExpression(declaration)!;
      return expression.kind === SyntaxKind.Identifier ? expression : undefined;
    }
  }
  return getName(declaration);
}

/** The name a function or class expression gets from the property, variable or assignment it initializes. */
export function getAssignedName(node: Node): Node | undefined {
  const parent = node.parent;
  if (parent === undefined) return undefined;
  switch (parent.kind) {
    case SyntaxKind.PropertyAssignment:
      return getName(parent);
    case SyntaxKind.BindingElement:
      return (parent as BindingElement).name;
    case SyntaxKind.BinaryExpression: {
      const binary = parent as BinaryExpression;
      if (node !== binary.right) return undefined;
      const left = binary.left;
      if (left.kind === SyntaxKind.Identifier) return left;
      if (left instanceof PropertyAccessExpression) return left.name;
      if (left instanceof ElementAccessExpression) {
        const argument = skipParentheses(left.argumentExpression);
        if (isStringOrNumericLiteralLike(argument)) return argument;
      }
      return undefined;
    }
    case SyntaxKind.VariableDeclaration: {
      const name = (parent as VariableDeclaration).name;
      return name.kind === SyntaxKind.Identifier ? name : undefined;
    }
  }
  return undefined;
}

export function getNameOfDeclaration(declaration: Node | undefined): Node | undefined {
  if (declaration === undefined) return undefined;
  const name = getNonAssignedNameOfDeclaration(declaration);
  if (name !== undefined) return name;
  if (isFunctionExpressionOrArrowFunction(declaration) || declaration.kind === SyntaxKind.ClassExpression)
    return getAssignedName(declaration);
  return undefined;
}

/** A computed name or element access whose name isn't a literal. */
export function isDynamicName(name: Node): boolean {
  let expression: Node;
  if (name.kind === SyntaxKind.ComputedPropertyName) expression = getExpression(name)!;
  else if (name instanceof ElementAccessExpression) expression = skipParentheses(name.argumentExpression);
  else return false;
  return !isStringOrNumericLiteralLike(expression) && !isSignedNumericLiteral(expression);
}

export function hasDynamicName(declaration: Node): boolean {
  const name = getNameOfDeclaration(declaration);
  return name !== undefined && isDynamicName(name);
}

export function isPartOfParameterDeclaration(node: Node): boolean {
  return getRootDeclaration(node).kind === SyntaxKind.Parameter;
}

export function isCatchClauseVariableDeclarationOrBindingElement(declaration: Node): boolean {
  const node = getRootDeclaration(declaration);
  return node.kind === SyntaxKind.VariableDeclaration && node.parent!.kind === SyntaxKind.CatchClause;
}

/** A `let`, `const`, `using` or catch variable. */
export function isBlockOrCatchScoped(declaration: Node): boolean {
  return (
    (getCombinedNodeFlags(declaration) & NodeFlags.BlockScoped) !== 0 ||
    isCatchClauseVariableDeclarationOrBindingElement(declaration)
  );
}

export function getContainingClass(node: Node): Node | undefined {
  let current = node.parent;
  while (current !== undefined && !isClassLike(current)) current = current.parent;
  return current;
}

/** The constructor of a class with a body. */
export function findConstructorDeclaration(node: Node): Node | undefined {
  const members = getMembers(node);
  if (members === undefined) return undefined;
  for (const member of members.nodes)
    if (member.kind === SyntaxKind.Constructor && !nodeIsMissing(getBody(member))) return member;
  return undefined;
}

/**
 * The nearest function, class member, namespace, enum or source file that determines `this`
 * for `node`; arrow functions count if `includeArrowFunctions`.
 */
export function getThisContainer(
  node: Node,
  includeArrowFunctions: boolean,
  includeClassComputedPropertyName: boolean,
): Node {
  let current = node;
  for (;;) {
    const parent = current.parent;
    if (parent === undefined) throw new Error('nil parent in getThisContainer');
    current = parent;
    switch (current.kind) {
      case SyntaxKind.ComputedPropertyName:
        if (includeClassComputedPropertyName && isClassLike(current.parent!.parent!)) return current;
        current = current.parent!.parent!;
        break;
      case SyntaxKind.Decorator:
        if (current.parent!.kind === SyntaxKind.Parameter && isClassElement(current.parent!.parent!))
          current = current.parent!.parent!;
        else if (isClassElement(current.parent!)) current = current.parent!;
        break;
      case SyntaxKind.ArrowFunction:
        if (includeArrowFunctions) return current;
        break;
      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.FunctionExpression:
      case SyntaxKind.ModuleDeclaration:
      case SyntaxKind.ClassStaticBlockDeclaration:
      case SyntaxKind.PropertyDeclaration:
      case SyntaxKind.PropertySignature:
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.MethodSignature:
      case SyntaxKind.Constructor:
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor:
      case SyntaxKind.CallSignature:
      case SyntaxKind.ConstructSignature:
      case SyntaxKind.IndexSignature:
      case SyntaxKind.EnumDeclaration:
      case SyntaxKind.SourceFile:
        return current;
    }
  }
}

/** Whether `node` is outside any function, class member or namespace. */
export function isInTopLevelContext(node: Node): boolean {
  let current = node;
  if (current.kind === SyntaxKind.Identifier) {
    const parent = current.parent!;
    if (
      (parent.kind === SyntaxKind.ClassDeclaration || parent.kind === SyntaxKind.FunctionDeclaration) &&
      getName(parent) === current
    )
      current = parent;
  }
  return getThisContainer(current, true, false).kind === SyntaxKind.SourceFile;
}

/** An identifier in a property name position, which never resolves to a symbol. */
export function isIdentifierName(node: Node): boolean {
  const parent = node.parent!;
  switch (parent.kind) {
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.MethodSignature:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.EnumMember:
    case SyntaxKind.PropertyAssignment:
    case SyntaxKind.PropertyAccessExpression:
      return getName(parent) === node;
    case SyntaxKind.QualifiedName:
      return (parent as QualifiedName).right === node;
    case SyntaxKind.BindingElement:
    case SyntaxKind.ImportSpecifier:
      return getPropertyName(parent) === node;
    case SyntaxKind.ExportSpecifier:
    case SyntaxKind.JsxAttribute:
    case SyntaxKind.JsxSelfClosingElement:
    case SyntaxKind.JsxOpeningElement:
    case SyntaxKind.JsxClosingElement:
      return true;
  }
  return false;
}

export function isPartOfTypeQuery(node: Node): boolean {
  let current = node;
  while (current.kind === SyntaxKind.QualifiedName || current.kind === SyntaxKind.Identifier) current = current.parent!;
  return current.kind === SyntaxKind.TypeQuery;
}

/** A statement that runs code, or a declaration that does (classes, enums, namespaces). */
export function isPotentiallyExecutableNode(node: Node): boolean {
  if (node.kind >= SyntaxKind.FirstStatement && node.kind <= SyntaxKind.LastStatement) {
    if (node instanceof VariableStatement) {
      const list = node.declarationList;
      if ((getCombinedNodeFlags(list) & NodeFlags.BlockScoped) !== 0) return true;
      for (const declaration of list.declarations.nodes) if (getInitializer(declaration) !== undefined) return true;
      return false;
    }
    return true;
  }
  return (
    node.kind === SyntaxKind.ClassDeclaration ||
    node.kind === SyntaxKind.EnumDeclaration ||
    node.kind === SyntaxKind.ModuleDeclaration
  );
}

/** A `declare module "m"` that augments an external module rather than declaring one. */
export function isModuleAugmentationExternal(node: Node): boolean {
  const parent = node.parent!;
  switch (parent.kind) {
    case SyntaxKind.SourceFile:
      return isExternalModule(parent as SourceFile);
    case SyntaxKind.ModuleBlock: {
      const grandParent = parent.parent!;
      return (
        grandParent instanceof ModuleDeclaration &&
        isAmbientModuleDeclaration(grandParent) &&
        grandParent.parent!.kind === SyntaxKind.SourceFile &&
        !isExternalModule(grandParent.parent as SourceFile)
      );
    }
  }
  return false;
}

function isAmbientModuleDeclaration(node: ModuleDeclaration): boolean {
  return node.name.kind === SyntaxKind.StringLiteral || node.keyword === SyntaxKind.GlobalKeyword;
}

export function moduleExportNameIsDefault(node: Node): boolean {
  return getText(node) === InternalSymbolName.Default;
}

export function getDeclarationOfKind(symbol: Symbol, kind: SyntaxKind): Node | undefined {
  for (const declaration of symbol.declarations) if (declaration.kind === kind) return declaration;
  return undefined;
}

/** The name of a symbol, with `#name` for private class members. */
export function symbolName(symbol: Symbol): string {
  const declaration = symbol.valueDeclaration;
  if (declaration !== undefined && isPrivateIdentifierClassElementDeclaration(declaration))
    return getText(getName(declaration)!);
  return symbol.name;
}

// Namespace instantiation

export const enum ModuleInstanceState {
  Unknown,
  /** Only types: interfaces, type aliases, non-exported imports. */
  NonInstantiated,
  Instantiated,
  /** Only const enums (and namespaces of them) as values. */
  ConstEnumOnly,
}

/** Whether a namespace declaration has a runtime value. Parents of `node` must be set. */
export function getModuleInstanceState(node: Node): ModuleInstanceState {
  return new ModuleInstanceStateComputer().ofModule(node as ModuleDeclaration, []);
}

class ModuleInstanceStateComputer extends NodeVisitor {
  private readonly visited: Map<Node, ModuleInstanceState>;
  // The module block whose children `visitNode` is folding into `blockState`.
  private blockAncestors: Node[];
  private blockState: ModuleInstanceState;

  constructor() {
    super();
    this.visited = new Map<Node, ModuleInstanceState>();
    this.blockAncestors = [];
    this.blockState = ModuleInstanceState.NonInstantiated;
  }

  ofModule(node: ModuleDeclaration, ancestors: Node[]): ModuleInstanceState {
    const body = node.body;
    return body === undefined ? ModuleInstanceState.Instantiated : this.cached(body, withAncestor(ancestors, node));
  }

  cached(node: Node, ancestors: Node[]): ModuleInstanceState {
    const cached = this.visited.get(node);
    if (cached !== undefined)
      return cached !== ModuleInstanceState.Unknown ? cached : ModuleInstanceState.NonInstantiated;
    this.visited.set(node, ModuleInstanceState.Unknown);
    const result = this.worker(node, ancestors);
    this.visited.set(node, result);
    return result;
  }

  worker(node: Node, ancestors: Node[]): ModuleInstanceState {
    switch (node.kind) {
      case SyntaxKind.InterfaceDeclaration:
      case SyntaxKind.TypeAliasDeclaration:
      case SyntaxKind.JSTypeAliasDeclaration:
        return ModuleInstanceState.NonInstantiated;
      case SyntaxKind.EnumDeclaration:
        if (isEnumConst(node)) return ModuleInstanceState.ConstEnumOnly;
        break;
      case SyntaxKind.ImportDeclaration:
      case SyntaxKind.JSImportDeclaration:
      case SyntaxKind.ImportEqualsDeclaration:
        if (!hasSyntacticModifier(node, ModifierFlags.Export)) return ModuleInstanceState.NonInstantiated;
        break;
      case SyntaxKind.ExportDeclaration: {
        const exportClause = (node as ExportDeclaration).exportClause;
        if (
          (node as ExportDeclaration).moduleSpecifier === undefined &&
          exportClause !== undefined &&
          exportClause.kind === SyntaxKind.NamedExports
        ) {
          let state = ModuleInstanceState.NonInstantiated;
          const specifierAncestors = withAncestor(withAncestor(ancestors, node), exportClause);
          for (const specifier of getElements(exportClause)!.nodes) {
            const specifierState = this.forAliasTarget(specifier, specifierAncestors);
            if (specifierState > state) state = specifierState;
            if (state === ModuleInstanceState.Instantiated) return state;
          }
          return state;
        }
        break;
      }
      case SyntaxKind.ModuleBlock: {
        const saveAncestors = this.blockAncestors;
        const saveState = this.blockState;
        this.blockAncestors = withAncestor(ancestors, node);
        this.blockState = ModuleInstanceState.NonInstantiated;
        node.forEachChild(this);
        const state = this.blockState;
        this.blockAncestors = saveAncestors;
        this.blockState = saveState;
        return state;
      }
      case SyntaxKind.ModuleDeclaration:
        return this.ofModule(node as ModuleDeclaration, ancestors);
    }
    return ModuleInstanceState.Instantiated;
  }

  visitNode(node: Node): boolean {
    const childState = this.cached(node, this.blockAncestors);
    switch (childState) {
      case ModuleInstanceState.NonInstantiated:
        return false;
      case ModuleInstanceState.ConstEnumOnly:
        this.blockState = ModuleInstanceState.ConstEnumOnly;
        return false;
      case ModuleInstanceState.Instantiated:
        this.blockState = ModuleInstanceState.Instantiated;
        return true;
    }
    throw new Error('Unhandled case in getModuleInstanceStateWorker');
  }

  forAliasTarget(specifier: Node, ancestors: Node[]): ModuleInstanceState {
    const propertyName = getPropertyName(specifier);
    const name = propertyName !== undefined ? propertyName : getName(specifier)!;
    // `export { "x" }` is invalid; assume a value.
    if (name.kind !== SyntaxKind.Identifier) return ModuleInstanceState.Instantiated;
    const text = getText(name);
    let remaining = ancestors.length;
    let p: Node | undefined = specifier;
    for (;;) {
      if (remaining === 0) p = p.parent;
      else p = ancestors[--remaining]!;
      if (p === undefined) break;
      if (p.kind !== SyntaxKind.Block && p.kind !== SyntaxKind.ModuleBlock && p.kind !== SyntaxKind.SourceFile)
        continue;
      let found = ModuleInstanceState.Unknown;
      const statementsAncestors = ancestors.slice(0, remaining);
      statementsAncestors.push(p);
      for (const statement of getStatements(p)!.nodes) {
        if (!nodeHasName(statement, text)) continue;
        const state = this.cached(statement, statementsAncestors);
        if (found === ModuleInstanceState.Unknown || state > found) found = state;
        if (found === ModuleInstanceState.Instantiated) return found;
        // A re-exported import alias is ambiguous, like `export import x = mod.x`.
        if (statement.kind === SyntaxKind.ImportEqualsDeclaration) found = ModuleInstanceState.Instantiated;
      }
      if (found !== ModuleInstanceState.Unknown) return found;
    }
    // Not found: it could be a value.
    return ModuleInstanceState.Instantiated;
  }
}

function withAncestor(ancestors: readonly Node[], node: Node): Node[] {
  const result = ancestors.slice();
  result.push(node);
  return result;
}

function nodeHasName(statement: Node, name: string): boolean {
  const declarationName = getName(statement);
  if (declarationName !== undefined)
    return declarationName.kind === SyntaxKind.Identifier && getText(declarationName) === name;
  if (statement instanceof VariableStatement) {
    for (const declaration of statement.declarationList.declarations.nodes)
      if (nodeHasName(declaration, name)) return true;
  }
  return false;
}

// Text and error ranges

/** Source text of `node` without leading trivia. */
export function getSourceTextOfNode(file: SourceFile, node: Node): string {
  if (nodeIsMissing(node)) return '';
  return file.text.substring(skipTrivia(file.text, node.pos), node.end);
}

/** A declaration name for messages: its source text, or `(Missing)`. */
export function declarationNameToString(file: SourceFile, name: Node | undefined): string {
  if (name === undefined || name.pos === name.end) return '(Missing)';
  return getTextOfNode(file, name);
}

function getTextOfNode(file: SourceFile, node: Node): string {
  const text = getSourceTextOfNode(file, node);
  if ((node.flags & NodeFlags.ReparserTransformedLiteral) !== 0 && node.kind === SyntaxKind.Identifier)
    return getText(node);
  return text;
}

/** A text range, as `[pos, end)`. */
export class TextRange {
  readonly pos: number;
  readonly end: number;

  constructor(pos: number, end: number) {
    this.pos = pos;
    this.end = end;
  }
}

let rangeScanner: Scanner | undefined;
let rangeScannerFile: SourceFile | undefined;

function scannerAt(file: SourceFile, pos: number): Scanner {
  let scanner = rangeScanner;
  if (scanner === undefined) {
    scanner = new Scanner();
    rangeScanner = scanner;
  }
  if (rangeScannerFile !== file) {
    scanner.setText(file.text);
    scanner.setLanguageVariant(file.languageVariant);
    rangeScannerFile = file;
  }
  scanner.resetTokenState(pos);
  scanner.scan();
  return scanner;
}

/** The token starting at or after `pos`. */
export function getRangeOfTokenAtPosition(file: SourceFile, pos: number): TextRange {
  const scanner = scannerAt(file, pos);
  return new TextRange(scanner.getTokenStart(), scanner.getTokenEnd());
}

function isLineBreak(ch: number): boolean {
  return ch === 0x0a || ch === 0x0d || ch === 0x2028 || ch === 0x2029;
}

function getErrorRangeForArrowFunction(file: SourceFile, node: Node): TextRange {
  const text = file.text;
  const pos = skipTrivia(text, node.pos);
  const body = getBody(node);
  if (body !== undefined && body.kind === SyntaxKind.Block) {
    const lineStarts = file.lineStarts();
    const startLine = computeLineOfPosition(lineStarts, body.pos);
    const endLine = computeLineOfPosition(lineStarts, body.end);
    if (startLine < endLine) {
      // A multi-line arrow function: the span is its first line, including the line break.
      let end: number = lineStarts[startLine]!;
      while (end < text.length && !isLineBreak(text.charCodeAt(end))) end += 1;
      return new TextRange(pos, end);
    }
  }
  return new TextRange(pos, node.end);
}

/** The `@satisfies` tag a reparsed `satisfies` expression came from. */
function findOriginatingJSDocSatisfiesTag(file: SourceFile, node: SatisfiesExpression): Node | undefined {
  const targetType = node.type;
  if ((targetType.flags & NodeFlags.Reparsed) === 0) return undefined;
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if ((current.flags & NodeFlags.HasJSDoc) === 0) continue;
    let first: Node | undefined;
    for (const jsDoc of getJSDoc(file, current)) {
      if (!(jsDoc instanceof JSDoc)) continue;
      const tagList = jsDoc.tags;
      if (tagList === undefined) continue;
      const tags = tagList.nodes;
      for (let i = 0; i < tags.length; i++) {
        const tag = tags[i]!;
        if (tag instanceof JSDocSatisfiesTag) {
          if (first === undefined) first = tag;
          const type = getType(tag.typeExpression);
          if (type !== undefined && type.pos === targetType.pos && type.end === targetType.end) return tag;
        }
      }
    }
    return first;
  }
  return undefined;
}

/** Where to report an error on `node`: usually its name, or its first token. */
export function getErrorRangeForNode(file: SourceFile, node: Node): TextRange {
  const text = file.text;
  let errorNode: Node | undefined = node;
  switch (node.kind) {
    case SyntaxKind.SourceFile: {
      const pos = skipTrivia(text, 0);
      return pos === text.length ? new TextRange(0, 0) : getRangeOfTokenAtPosition(file, pos);
    }
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.MethodDeclaration:
      if ((node.flags & NodeFlags.Reparsed) === 0) errorNode = getNameOfDeclaration(node);
      break;
    case SyntaxKind.VariableDeclaration:
    case SyntaxKind.BindingElement:
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.InterfaceDeclaration:
    case SyntaxKind.ModuleDeclaration:
    case SyntaxKind.EnumDeclaration:
    case SyntaxKind.EnumMember:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.TypeAliasDeclaration:
    case SyntaxKind.JSTypeAliasDeclaration:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.NamespaceImport:
      errorNode = getNameOfDeclaration(node);
      break;
    case SyntaxKind.ClassExpression:
      errorNode = getName(node);
      break;
    case SyntaxKind.ArrowFunction:
      return getErrorRangeForArrowFunction(file, node);
    case SyntaxKind.CaseClause:
    case SyntaxKind.DefaultClause: {
      const start = skipTrivia(text, node.pos);
      const statements = getStatements(node)!.nodes;
      return new TextRange(start, statements.length !== 0 ? statements[0]!.pos : node.end);
    }
    case SyntaxKind.ReturnStatement:
    case SyntaxKind.YieldExpression:
      return getRangeOfTokenAtPosition(file, skipTrivia(text, node.pos));
    case SyntaxKind.SatisfiesExpression: {
      const tag = findOriginatingJSDocSatisfiesTag(file, node as SatisfiesExpression);
      if (tag !== undefined) return getRangeOfTokenAtPosition(file, skipTrivia(text, getTagName(tag)!.pos));
      return getRangeOfTokenAtPosition(file, skipTrivia(text, getExpression(node)!.end));
    }
    case SyntaxKind.Constructor: {
      if ((node.flags & NodeFlags.Reparsed) !== 0) break;
      const scanner = scannerAt(file, node.pos);
      const start = scanner.getTokenStart();
      for (;;) {
        const token = scanner.getToken();
        if (
          token === SyntaxKind.ConstructorKeyword ||
          token === SyntaxKind.StringLiteral ||
          token === SyntaxKind.EndOfFile
        )
          break;
        scanner.scan();
      }
      return new TextRange(start, scanner.getTokenEnd());
    }
  }
  // Without a better node, use the first token of the construct.
  if (errorNode === undefined) return getRangeOfTokenAtPosition(file, node.pos);
  let pos = errorNode.pos;
  if (!nodeIsMissing(errorNode) && errorNode.kind !== SyntaxKind.JsxText) pos = skipTrivia(text, pos);
  return new TextRange(pos, errorNode.end);
}
