// NamedEvaluation (https://tc39.es/ecma262/#sec-runtime-semantics-namedevaluation): giving
// anonymous classes and functions the name they would get from where they are assigned, once a
// transform moves them somewhere they wouldn't.
import {
  BinaryExpression,
  BindingElement,
  CallExpression,
  ClassExpression,
  ClassStaticBlockDeclaration,
  ComputedPropertyName,
  ExportAssignment,
  ExpressionStatement,
  FunctionExpression,
  Identifier,
  ModifierFlags,
  type Node,
  NodeList,
  ParameterDeclaration,
  PropertyAssignment,
  PropertyDeclaration,
  ShorthandPropertyAssignment,
  StringLiteral,
  VariableDeclaration,
  getName,
} from '../ast.js';
import { hasSyntacticModifier, isClassLike, isPropertyNameLiteral } from '../binder-utilities.js';
import { createPropKeyHelper, createSetFunctionNameHelper } from '../printer/decorator-helpers.js';
import type { EmitContext } from '../printer/emit-context.js';
import { SyntaxKind } from '../syntax-kind.js';
import { TokenFlags } from '../types.js';
import { getClassMembers, getClassName, isClassThisAssignmentBlock, updateClassMembers } from './class-utilities.js';
import { OuterExpressionKinds, skipOuterExpressions } from './utilities.js';

/** Further narrows which anonymous function definitions a transform names. */
export abstract class AnonymousFunctionFilter {
  abstract accepts(node: Node): boolean;
}

/** A `static {}` block holding only `__setFunctionName(this, name)` for the block's assigned name. */
export function isClassNamedEvaluationHelperBlock(context: EmitContext, node: Node): boolean {
  if (!(node instanceof ClassStaticBlockDeclaration)) return false;
  const statements = node.body.statements.nodes;
  if (statements.length !== 1) return false;
  const statement = statements[0];
  if (!(statement instanceof ExpressionStatement)) return false;
  const expression = statement.expression;
  if (!context.isCallToHelper(expression, '__setFunctionName') || !(expression instanceof CallExpression)) return false;
  const args = expression.arguments.nodes;
  return args.length >= 2 && args[1] === context.getAssignedName(node);
}

/** Whether a class has a NamedEvaluation helper block. */
export function classHasExplicitlyAssignedName(context: EmitContext, node: Node): boolean {
  if (context.getAssignedName(node) === undefined) return false;
  const members = getClassMembers(node).nodes;
  for (let i = 0; i < members.length; i++) if (isClassNamedEvaluationHelperBlock(context, members[i])) return true;
  return false;
}

export function classHasDeclaredOrExplicitlyAssignedName(context: EmitContext, node: Node): boolean {
  return getClassName(node) !== undefined || classHasExplicitlyAssignedName(context, node);
}

/** https://tc39.es/ecma262/#sec-isanonymousfunctiondefinition */
export function isAnonymousFunctionDefinition(
  context: EmitContext,
  node: Node | undefined,
  filter: AnonymousFunctionFilter | undefined,
): boolean {
  if (node === undefined) return false;
  node = skipOuterExpressions(node, OuterExpressionKinds.All);
  switch (node.kind) {
    case SyntaxKind.ClassExpression:
      if (classHasDeclaredOrExplicitlyAssignedName(context, node)) return false;
      break;
    case SyntaxKind.FunctionExpression:
      if (node instanceof FunctionExpression && node.name !== undefined) return false;
      break;
    case SyntaxKind.ArrowFunction:
      break;
    default:
      return false;
  }
  return filter === undefined || filter.accepts(node);
}

/** Whether `node` may give an assigned name to a class, function or arrow function. */
export function isNamedEvaluationSource(node: Node): boolean {
  if (node instanceof PropertyAssignment) return !isProtoSetter(node.name);
  if (node instanceof ShorthandPropertyAssignment) return node.objectAssignmentInitializer !== undefined;
  if (node instanceof VariableDeclaration) return node.name instanceof Identifier && node.initializer !== undefined;
  if (node instanceof ParameterDeclaration)
    return node.name instanceof Identifier && node.initializer !== undefined && node.dotDotDotToken === undefined;
  if (node instanceof BindingElement)
    return node.name instanceof Identifier && node.initializer !== undefined && node.dotDotDotToken === undefined;
  if (node instanceof PropertyDeclaration) return node.initializer !== undefined;
  if (node instanceof BinaryExpression) {
    switch (node.operatorToken.kind) {
      case SyntaxKind.EqualsToken:
      case SyntaxKind.AmpersandAmpersandEqualsToken:
      case SyntaxKind.BarBarEqualsToken:
      case SyntaxKind.QuestionQuestionEqualsToken:
        return node.left instanceof Identifier;
    }
    return false;
  }
  return node instanceof ExportAssignment;
}

function isProtoSetter(node: Node): boolean {
  return (
    (node instanceof Identifier && node.text === '__proto__') ||
    (node instanceof StringLiteral && node.text === '__proto__')
  );
}

/** Whether `node` assigns a name to an anonymous function definition accepted by `filter`. */
export function isNamedEvaluation(
  context: EmitContext,
  node: Node,
  filter: AnonymousFunctionFilter | undefined,
): boolean {
  if (!isNamedEvaluationSource(node)) return false;
  return isAnonymousFunctionDefinition(context, namedEvaluationValue(node), filter);
}

/** The anonymous function definition a NamedEvaluation source names. */
function namedEvaluationValue(node: Node): Node | undefined {
  if (node instanceof ShorthandPropertyAssignment) return node.objectAssignmentInitializer;
  if (node instanceof PropertyAssignment) return node.initializer;
  if (node instanceof VariableDeclaration) return node.initializer;
  if (node instanceof ParameterDeclaration) return node.initializer;
  if (node instanceof BindingElement) return node.initializer;
  if (node instanceof PropertyDeclaration) return node.initializer;
  if (node instanceof BinaryExpression) return node.right;
  if (node instanceof ExportAssignment) return node.expression;
  return undefined;
}

function getAssignedNameOfIdentifier(context: EmitContext, name: Node, expression: Node): Node {
  const original = context.mostOriginal(skipOuterExpressions(expression, OuterExpressionKinds.All));
  if (
    (original.kind === SyntaxKind.ClassDeclaration || original.kind === SyntaxKind.FunctionDeclaration) &&
    getName(original) === undefined &&
    hasSyntacticModifier(original, ModifierFlags.Default)
  )
    return context.factory.createStringLiteral('default', TokenFlags.None);
  return context.factory.createStringLiteralFromNode(name);
}

/** The assigned name for a property name, and the name, updated to cache a computed key. */
class AssignedPropertyName {
  readonly assignedName: Node;
  readonly name: Node;

  constructor(assignedName: Node, name: Node) {
    this.assignedName = assignedName;
    this.name = name;
  }
}

function getAssignedNameOfPropertyName(context: EmitContext, name: Node, text: string): AssignedPropertyName {
  const factory = context.factory;
  if (text.length > 0) return new AssignedPropertyName(factory.createStringLiteral(text, TokenFlags.None), name);
  if (isPropertyNameLiteral(name) || name.kind === SyntaxKind.PrivateIdentifier)
    return new AssignedPropertyName(factory.createStringLiteralFromNode(name), name);
  if (!(name instanceof ComputedPropertyName)) throw new Error('Expected a computed property name');
  const computed = name;
  const expression = computed.expression;
  if (isPropertyNameLiteral(expression) && !(expression instanceof Identifier))
    return new AssignedPropertyName(factory.createStringLiteralFromNode(expression), name);
  const assignedName = factory.createGeneratedNameForNode(name, 0, '', '');
  context.addVariableDeclaration(assignedName);
  const assignment = factory.createAssignment(assignedName, createPropKeyHelper(factory, expression));
  const updatedName: Node = factory.updateComputedPropertyName(computed, assignment);
  return new AssignedPropertyName(assignedName, updatedName);
}

/** `static { __setFunctionName(this, assignedName); }` for setting a class name at runtime. */
export function createClassNamedEvaluationHelperBlock(
  context: EmitContext,
  assignedName: Node,
  thisExpression: Node | undefined,
): ClassStaticBlockDeclaration {
  const factory = context.factory;
  const self = thisExpression !== undefined ? thisExpression : factory.createKeywordExpression(SyntaxKind.ThisKeyword);
  const statement = factory.createExpressionStatement(createSetFunctionNameHelper(factory, self, assignedName, ''));
  const block = factory.created(new ClassStaticBlockDeclaration(undefined, factory.createBlock([statement], false)));
  context.setAssignedName(block, assignedName);
  return block;
}

/** Adds a NamedEvaluation helper block to a class, after its `_classThis` block, unless it has one. */
export function injectClassNamedEvaluationHelperBlockIfMissing(
  context: EmitContext,
  node: Node,
  assignedName: Node,
  thisExpression: Node | undefined,
): Node {
  if (classHasExplicitlyAssignedName(context, node)) return node;
  if (!isClassLike(node)) return node;
  const block = createClassNamedEvaluationHelperBlock(context, assignedName, thisExpression);
  const name = getClassName(node);
  if (name !== undefined) context.setSourceMapRange(block.body.statements.nodes[0], name.pos, name.end);
  const memberList = getClassMembers(node);
  const existing = memberList.nodes;
  let insertion = 0;
  for (let i = 0; i < existing.length; i++)
    if (isClassThisAssignmentBlock(context, existing[i])) {
      insertion = i + 1;
      break;
    }
  const members = existing.slice(0, insertion);
  members.push(block);
  for (let i = insertion; i < existing.length; i++) members.push(existing[i]);
  const list = new NodeList(memberList.pos, memberList.end, members);
  const updated = updateClassMembers(context.factory, node, list);
  context.setAssignedName(updated, assignedName);
  const classThis = context.getClassThis(node);
  if (classThis !== undefined) context.setClassThis(updated, classThis);
  return updated;
}

function finishTransformNamedEvaluation(
  context: EmitContext,
  expression: Node,
  assignedName: Node,
  ignoreEmptyStringLiteral: boolean,
): Node {
  if (ignoreEmptyStringLiteral && assignedName instanceof StringLiteral && assignedName.text.length === 0)
    return expression;
  const inner = skipOuterExpressions(expression, OuterExpressionKinds.All);
  const updated =
    inner instanceof ClassExpression
      ? injectClassNamedEvaluationHelperBlockIfMissing(context, inner, assignedName, undefined)
      : createSetFunctionNameHelper(context.factory, inner, assignedName, '');
  return context.factory.restoreOuterExpressions(expression, updated, OuterExpressionKinds.All);
}

function assignedNameOf(context: EmitContext, text: string, name: Node, expression: Node): Node {
  return text.length > 0
    ? context.factory.createStringLiteral(text, TokenFlags.None)
    : getAssignedNameOfIdentifier(context, name, expression);
}

/**
 * Transforms a NamedEvaluation source so its anonymous class or function gets its name
 * explicitly; `assignedNameText` overrides the name.
 */
export function transformNamedEvaluation(
  context: EmitContext,
  node: Node,
  ignoreEmptyStringLiteral: boolean,
  assignedNameText: string,
): Node {
  const factory = context.factory;
  if (node instanceof PropertyAssignment) {
    const propertyAssignment = node;
    const assigned = getAssignedNameOfPropertyName(context, propertyAssignment.name, assignedNameText);
    const initializer = finishTransformNamedEvaluation(
      context,
      propertyAssignment.initializer,
      assigned.assignedName,
      ignoreEmptyStringLiteral,
    );
    return factory.updatePropertyAssignment(
      propertyAssignment,
      undefined,
      assigned.name,
      undefined,
      undefined,
      initializer,
    );
  }
  if (node instanceof ShorthandPropertyAssignment) {
    const shorthandPropertyAssignment = node;
    const value = shorthandPropertyAssignment.objectAssignmentInitializer!;
    const assignedName = assignedNameOf(context, assignedNameText, shorthandPropertyAssignment.name, value);
    const initializer = finishTransformNamedEvaluation(context, value, assignedName, ignoreEmptyStringLiteral);
    return factory.updateShorthandPropertyAssignment(
      shorthandPropertyAssignment,
      undefined,
      shorthandPropertyAssignment.name,
      undefined,
      undefined,
      shorthandPropertyAssignment.equalsToken,
      initializer,
    );
  }
  if (node instanceof VariableDeclaration) {
    const variableDeclaration = node;
    const value = variableDeclaration.initializer!;
    const assignedName = assignedNameOf(context, assignedNameText, variableDeclaration.name, value);
    const initializer = finishTransformNamedEvaluation(context, value, assignedName, ignoreEmptyStringLiteral);
    return factory.updateVariableDeclaration(
      variableDeclaration,
      variableDeclaration.name,
      undefined,
      undefined,
      initializer,
    );
  }
  if (node instanceof ParameterDeclaration) {
    const parameterDeclaration = node;
    const value = parameterDeclaration.initializer!;
    const assignedName = assignedNameOf(context, assignedNameText, parameterDeclaration.name, value);
    const initializer = finishTransformNamedEvaluation(context, value, assignedName, ignoreEmptyStringLiteral);
    return factory.updateParameterDeclaration(
      parameterDeclaration,
      undefined,
      parameterDeclaration.dotDotDotToken,
      parameterDeclaration.name,
      undefined,
      undefined,
      initializer,
    );
  }
  if (node instanceof BindingElement) {
    const bindingElement = node;
    const value = bindingElement.initializer!;
    const assignedName = assignedNameOf(context, assignedNameText, bindingElement.name!, value);
    const initializer = finishTransformNamedEvaluation(context, value, assignedName, ignoreEmptyStringLiteral);
    return factory.updateBindingElement(
      bindingElement,
      bindingElement.dotDotDotToken,
      bindingElement.propertyName,
      bindingElement.name,
      initializer,
    );
  }
  if (node instanceof PropertyDeclaration) {
    const propertyDeclaration = node;
    const assigned = getAssignedNameOfPropertyName(context, propertyDeclaration.name, assignedNameText);
    const initializer = finishTransformNamedEvaluation(
      context,
      propertyDeclaration.initializer!,
      assigned.assignedName,
      ignoreEmptyStringLiteral,
    );
    return factory.updatePropertyDeclaration(
      propertyDeclaration,
      propertyDeclaration.modifiers,
      assigned.name,
      undefined,
      undefined,
      initializer,
    );
  }
  if (node instanceof BinaryExpression) {
    const binaryExpression = node;
    const assignedName = assignedNameOf(context, assignedNameText, binaryExpression.left, binaryExpression.right);
    const right = finishTransformNamedEvaluation(
      context,
      binaryExpression.right,
      assignedName,
      ignoreEmptyStringLiteral,
    );
    return factory.updateBinaryExpression(
      binaryExpression,
      undefined,
      binaryExpression.left,
      undefined,
      binaryExpression.operatorToken,
      right,
    );
  }
  if (node instanceof ExportAssignment) {
    const exportAssignment = node;
    // `export =` becomes `module.exports = ...`, which assigns the name `""`.
    const assignedName = factory.createStringLiteral(
      assignedNameText.length > 0 ? assignedNameText : exportAssignment.isExportEquals ? '' : 'default',
      TokenFlags.None,
    );
    const expression = finishTransformNamedEvaluation(
      context,
      exportAssignment.expression,
      assignedName,
      ignoreEmptyStringLiteral,
    );
    return factory.updateExportAssignment(
      exportAssignment,
      undefined,
      exportAssignment.isExportEquals,
      undefined,
      expression,
    );
  }
  return node;
}
