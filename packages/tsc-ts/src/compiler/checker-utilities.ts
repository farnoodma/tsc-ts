// Small helpers shared across checker modules.
import {
  BinaryExpression,
  ModifierFlags,
  type Node,
  getAsteriskToken,
  getBody,
  getExpression,
  getName,
  ElementAccessExpression,
} from './ast.js';
import { hasSyntacticModifier } from './binder-utilities.js';
import { SyntaxKind } from './syntax-kind.js';
import type { Checker } from './checker.js';
import { type LiteralType, type Type, TypeFlags, type UniqueESSymbolType } from './checker-types.js';
import { isGenericType } from './checker-type-operators.js';
import { isPatternLiteralType, typesOf } from './checker-type-factory.js';
import { checkComputedPropertyName, checkExpressionCached } from './checker-expressions.js';
import { isTypeAssignableTo } from './relations.js';

export function isTypeUsableAsPropertyName(t: Type): boolean {
  return (t.flags & TypeFlags.StringOrNumberLiteralOrUnique) !== 0;
}

/** The member name a literal or unique symbol type denotes. */
export function getPropertyNameFromType(t: Type): string {
  if ((t.flags & TypeFlags.StringLiteral) !== 0) return (t as LiteralType).stringValue;
  if ((t.flags & TypeFlags.NumberLiteral) !== 0) return String((t as LiteralType).numberValue);
  return (t as UniqueESSymbolType).name;
}

/** Whether `ToString(ToNumber(name))` is `name`; true for Infinity, -Infinity and NaN. */
export function isNumericLiteralName(name: string): boolean {
  return String(Number(name)) === name;
}

/** Names of members keyed by unique symbols. */
export function isLateBoundName(name: string): boolean {
  return name.length >= 2 && name.charCodeAt(0) === 0xfffe && name.charCodeAt(1) === 0x40;
}

export function maybeTypeOfKind(t: Type, kind: TypeFlags): boolean {
  if ((t.flags & kind) !== 0) return true;
  if ((t.flags & TypeFlags.UnionOrIntersection) !== 0)
    for (const u of typesOf(t)) if (maybeTypeOfKind(u, kind)) return true;
  return false;
}

export function isValidIndexKeyType(c: Checker, t: Type): boolean {
  if ((t.flags & (TypeFlags.String | TypeFlags.Number | TypeFlags.ESSymbol)) !== 0 || isPatternLiteralType(c, t))
    return true;
  if ((t.flags & TypeFlags.Intersection) !== 0 && !isGenericType(c, t))
    for (const u of typesOf(t)) if (isValidIndexKeyType(c, u)) return true;
  return false;
}

function isEntityNameExpression(node: Node): boolean {
  if (node.kind === SyntaxKind.Identifier) return true;
  if (node.kind === SyntaxKind.PropertyAccessExpression) {
    const name = getName(node);
    return name !== undefined && name.kind === SyntaxKind.Identifier && isEntityNameExpression(getExpression(node)!);
  }
  return false;
}

function isLateBindableAST(node: Node): boolean {
  let expr: Node | undefined;
  if (node.kind === SyntaxKind.ComputedPropertyName) expr = getExpression(node);
  else if (node.kind === SyntaxKind.ElementAccessExpression)
    expr = (node as ElementAccessExpression).argumentExpression;
  return expr !== undefined && isEntityNameExpression(expr);
}

/** A computed name of entity-name form whose type is a literal or unique symbol. */
export function hasLateBindableName(c: Checker, node: Node): boolean {
  const name = getLateBindableNameOfDeclaration(node);
  return name !== undefined && isLateBindableName(c, name);
}

/** Whether a computed name or `F[name]` target has a unique symbol or literal type. */
export function isLateBindableName(c: Checker, name: Node): boolean {
  if (!isLateBindableAST(name)) return false;
  if (name.kind === SyntaxKind.ComputedPropertyName)
    return isTypeUsableAsPropertyName(checkComputedPropertyName(c, name));
  return isTypeUsableAsPropertyName(checkExpressionCached(c, (name as ElementAccessExpression).argumentExpression));
}

/** The name of a member, or the `F[name]` target of a JavaScript element access assignment. */
export function getLateBindableNameOfDeclaration(node: Node): Node | undefined {
  return node instanceof BinaryExpression ? node.left : getName(node);
}

export function hasLateBindableIndexSignature(c: Checker, node: Node): boolean {
  const name = getName(node);
  if (name === undefined || !isLateBindableAST(name) || name.kind !== SyntaxKind.ComputedPropertyName) return false;
  return isTypeAssignableTo(c, checkComputedPropertyName(c, name), c.stringNumberSymbolType);
}

/** Whether a declaration's name is a computed name that isn't a literal. */
export function hasDynamicName(node: Node): boolean {
  const name = getName(node);
  if (name === undefined || name.kind !== SyntaxKind.ComputedPropertyName) return false;
  const e = getExpression(name)!;
  return !(
    e.kind === SyntaxKind.StringLiteral ||
    e.kind === SyntaxKind.NumericLiteral ||
    e.kind === SyntaxKind.NoSubstitutionTemplateLiteral
  );
}

export const enum FunctionFlags {
  Normal = 0,
  Generator = 1 << 0,
  Async = 1 << 1,
  Invalid = 1 << 2,
  AsyncGenerator = Async | Generator,
}

/** Whether a function-like declaration is async and/or a generator. */
export function getFunctionFlags(node: Node | undefined): FunctionFlags {
  if (node === undefined) return FunctionFlags.Invalid;
  let flags = FunctionFlags.Normal;
  switch (node.kind) {
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.MethodDeclaration:
      if (getAsteriskToken(node) !== undefined) flags |= FunctionFlags.Generator;
      if (hasSyntacticModifier(node, ModifierFlags.Async)) flags |= FunctionFlags.Async;
      break;
    case SyntaxKind.ArrowFunction:
      if (hasSyntacticModifier(node, ModifierFlags.Async)) flags |= FunctionFlags.Async;
      break;
  }
  if (getBody(node) === undefined) flags |= FunctionFlags.Invalid;
  return flags;
}

export function isBindingPattern(node: Node | undefined): boolean {
  return (
    node !== undefined &&
    (node.kind === SyntaxKind.ObjectBindingPattern || node.kind === SyntaxKind.ArrayBindingPattern)
  );
}

/** The index of the node with `node`'s range among `nodes`, which are in source order; -1 if none. */
export function indexOfNode(nodes: readonly Node[], node: Node): number {
  let low = 0;
  let high = nodes.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const n = nodes[middle]!;
    const order = n.pos !== node.pos ? n.pos - node.pos : n.end - node.end;
    if (order < 0) low = middle + 1;
    else high = middle;
  }
  if (low < nodes.length) {
    const n = nodes[low]!;
    if (n.pos === node.pos && n.end === node.end) return low;
  }
  return -1;
}
