// Object literal types: freshness and regular forms.
import type { Checker } from './checker.js';
import { CheckFlags, type Symbol, getSymbolId } from './symbol.js';
import { CachedTypeKind, cachedTypeKey, ObjectFlags, type Type, TypeFlags } from './checker-types.js';
import { createAnonymousType } from './checker-type-factory.js';
import { compactMembers, getPropertiesOfObjectType, resolveStructuredTypeMembers } from './checker-members.js';
import { getTypeOfSymbol } from './checker-symbol-types.js';
import { getLiteralTypeFromProperty } from './checker-type-operators.js';

/** The non-fresh form of an object literal type, with nested object literals regular too. */
export function getRegularTypeOfObjectLiteral(c: Checker, t: Type): Type {
  if (
    (t.objectFlags & ObjectFlags.ObjectLiteral) === 0 ||
    (t.objectFlags & ObjectFlags.FreshLiteral) === 0 ||
    (t.flags & TypeFlags.Object) === 0
  )
    return t;
  const key = cachedTypeKey(CachedTypeKind.RegularObjectLiteral, t.id);
  const cached = c.cachedTypesById.get(key);
  if (cached !== undefined) return cached;
  const resolved = resolveStructuredTypeMembers(c, t);
  const members = new Map<string, Symbol>();
  for (const prop of getPropertiesOfObjectType(c, t)) {
    const original = getTypeOfSymbol(c, prop);
    const updated = getRegularTypeOfObjectLiteral(c, original);
    members.set(prop.name, updated === original ? prop : createSymbolWithTypeLocal(c, prop, updated));
  }
  const regular = createAnonymousType(
    c,
    t.symbol,
    members,
    resolved.callSignatures,
    resolved.constructSignatures,
    resolved.indexInfos,
  );
  compactMembers(c, regular);
  regular.flags = resolved.flags;
  regular.objectFlags |= resolved.objectFlags & ~ObjectFlags.FreshLiteral;
  c.cachedTypesById.set(key, regular);
  return regular;
}

function createSymbolWithTypeLocal(c: Checker, source: Symbol, t: Type): Symbol {
  const symbol = c.newSymbolWithCheckFlags(source.flags, source.name, source.checkFlags & CheckFlags.Readonly);
  symbol.declarations = source.declarations;
  symbol.parent = source.parent;
  symbol.valueDeclaration = source.valueDeclaration;
  const id = getSymbolId(symbol);
  c.symbolTypes.set(id, t);
  c.symbolTargets.set(id, source);
  c.symbolNameTypes.set(id, c.symbolNameTypes.get(getSymbolId(source)));
  return symbol;
}

export function getLiteralTypeFromPropertyForRelations(
  c: Checker,
  prop: Symbol,
  include: TypeFlags,
  includeNonPublic: boolean,
): Type {
  return getLiteralTypeFromProperty(c, prop, include, includeNonPublic);
}
