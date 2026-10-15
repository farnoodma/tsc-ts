// Control flow: type facts and narrowing of references along the binder's flow graph.
import type { Checker } from './checker.js';
import { type LiteralType, ObjectFlags, type Type, TypeFlags } from './checker-types.js';
import {
  filterType,
  getIntersectionType,
  getUnionType,
  isEmptyObjectType,
  mapType,
  typesOf,
} from './checker-type-factory.js';
import { getResolvedMember, getBaseConstraintOfType, resolveStructuredTypeMembers } from './checker-members.js';
import { isTypeSubtypeOf } from './relations.js';
import { maybeTypeOfKind } from './checker-utilities.js';
import { getGlobalTypeAliasSymbol } from './checker-symbols.js';
import { getTypeAliasInstantiation } from './checker-type-nodes.js';

export const enum TypeFacts {
  None = 0,
  TypeofEQString = 1 << 0,
  TypeofEQNumber = 1 << 1,
  TypeofEQBigInt = 1 << 2,
  TypeofEQBoolean = 1 << 3,
  TypeofEQSymbol = 1 << 4,
  TypeofEQObject = 1 << 5,
  TypeofEQFunction = 1 << 6,
  TypeofEQHostObject = 1 << 7,
  TypeofNEString = 1 << 8,
  TypeofNENumber = 1 << 9,
  TypeofNEBigInt = 1 << 10,
  TypeofNEBoolean = 1 << 11,
  TypeofNESymbol = 1 << 12,
  TypeofNEObject = 1 << 13,
  TypeofNEFunction = 1 << 14,
  TypeofNEHostObject = 1 << 15,
  EQUndefined = 1 << 16,
  EQNull = 1 << 17,
  EQUndefinedOrNull = 1 << 18,
  NEUndefined = 1 << 19,
  NENull = 1 << 20,
  NEUndefinedOrNull = 1 << 21,
  Truthy = 1 << 22,
  Falsy = 1 << 23,
  IsUndefined = 1 << 24,
  IsNull = 1 << 25,
  IsUndefinedOrNull = IsUndefined | IsNull,
  All = (1 << 27) - 1,
  BaseStringStrictFacts = TypeofEQString |
    TypeofNENumber |
    TypeofNEBigInt |
    TypeofNEBoolean |
    TypeofNESymbol |
    TypeofNEObject |
    TypeofNEFunction |
    TypeofNEHostObject |
    NEUndefined |
    NENull |
    NEUndefinedOrNull,
  BaseStringFacts = BaseStringStrictFacts | EQUndefined | EQNull | EQUndefinedOrNull | Falsy,
  StringStrictFacts = BaseStringStrictFacts | Truthy | Falsy,
  StringFacts = BaseStringFacts | Truthy,
  EmptyStringStrictFacts = BaseStringStrictFacts | Falsy,
  EmptyStringFacts = BaseStringFacts,
  NonEmptyStringStrictFacts = BaseStringStrictFacts | Truthy,
  NonEmptyStringFacts = BaseStringFacts | Truthy,
  BaseNumberStrictFacts = TypeofEQNumber |
    TypeofNEString |
    TypeofNEBigInt |
    TypeofNEBoolean |
    TypeofNESymbol |
    TypeofNEObject |
    TypeofNEFunction |
    TypeofNEHostObject |
    NEUndefined |
    NENull |
    NEUndefinedOrNull,
  BaseNumberFacts = BaseNumberStrictFacts | EQUndefined | EQNull | EQUndefinedOrNull | Falsy,
  NumberStrictFacts = BaseNumberStrictFacts | Truthy | Falsy,
  NumberFacts = BaseNumberFacts | Truthy,
  ZeroNumberStrictFacts = BaseNumberStrictFacts | Falsy,
  ZeroNumberFacts = BaseNumberFacts,
  NonZeroNumberStrictFacts = BaseNumberStrictFacts | Truthy,
  NonZeroNumberFacts = BaseNumberFacts | Truthy,
  BaseBigIntStrictFacts = TypeofEQBigInt |
    TypeofNEString |
    TypeofNENumber |
    TypeofNEBoolean |
    TypeofNESymbol |
    TypeofNEObject |
    TypeofNEFunction |
    TypeofNEHostObject |
    NEUndefined |
    NENull |
    NEUndefinedOrNull,
  BaseBigIntFacts = BaseBigIntStrictFacts | EQUndefined | EQNull | EQUndefinedOrNull | Falsy,
  BigIntStrictFacts = BaseBigIntStrictFacts | Truthy | Falsy,
  BigIntFacts = BaseBigIntFacts | Truthy,
  ZeroBigIntStrictFacts = BaseBigIntStrictFacts | Falsy,
  ZeroBigIntFacts = BaseBigIntFacts,
  NonZeroBigIntStrictFacts = BaseBigIntStrictFacts | Truthy,
  NonZeroBigIntFacts = BaseBigIntFacts | Truthy,
  BaseBooleanStrictFacts = TypeofEQBoolean |
    TypeofNEString |
    TypeofNENumber |
    TypeofNEBigInt |
    TypeofNESymbol |
    TypeofNEObject |
    TypeofNEFunction |
    TypeofNEHostObject |
    NEUndefined |
    NENull |
    NEUndefinedOrNull,
  BaseBooleanFacts = BaseBooleanStrictFacts | EQUndefined | EQNull | EQUndefinedOrNull | Falsy,
  BooleanStrictFacts = BaseBooleanStrictFacts | Truthy | Falsy,
  BooleanFacts = BaseBooleanFacts | Truthy,
  FalseStrictFacts = BaseBooleanStrictFacts | Falsy,
  FalseFacts = BaseBooleanFacts,
  TrueStrictFacts = BaseBooleanStrictFacts | Truthy,
  TrueFacts = BaseBooleanFacts | Truthy,
  SymbolStrictFacts = TypeofEQSymbol |
    TypeofNEString |
    TypeofNENumber |
    TypeofNEBigInt |
    TypeofNEBoolean |
    TypeofNEObject |
    TypeofNEFunction |
    TypeofNEHostObject |
    NEUndefined |
    NENull |
    NEUndefinedOrNull |
    Truthy,
  SymbolFacts = SymbolStrictFacts | EQUndefined | EQNull | EQUndefinedOrNull | Falsy,
  ObjectStrictFacts = TypeofEQObject |
    TypeofEQHostObject |
    TypeofNEString |
    TypeofNENumber |
    TypeofNEBigInt |
    TypeofNEBoolean |
    TypeofNESymbol |
    TypeofNEFunction |
    NEUndefined |
    NENull |
    NEUndefinedOrNull |
    Truthy,
  ObjectFacts = ObjectStrictFacts | EQUndefined | EQNull | EQUndefinedOrNull | Falsy,
  FunctionStrictFacts = TypeofEQFunction |
    TypeofEQHostObject |
    TypeofNEString |
    TypeofNENumber |
    TypeofNEBigInt |
    TypeofNEBoolean |
    TypeofNESymbol |
    TypeofNEObject |
    NEUndefined |
    NENull |
    NEUndefinedOrNull |
    Truthy,
  FunctionFacts = FunctionStrictFacts | EQUndefined | EQNull | EQUndefinedOrNull | Falsy,
  VoidFacts = TypeofNEString |
    TypeofNENumber |
    TypeofNEBigInt |
    TypeofNEBoolean |
    TypeofNESymbol |
    TypeofNEObject |
    TypeofNEFunction |
    TypeofNEHostObject |
    EQUndefined |
    EQUndefinedOrNull |
    NENull |
    Falsy,
  UndefinedFacts = TypeofNEString |
    TypeofNENumber |
    TypeofNEBigInt |
    TypeofNEBoolean |
    TypeofNESymbol |
    TypeofNEObject |
    TypeofNEFunction |
    TypeofNEHostObject |
    EQUndefined |
    EQUndefinedOrNull |
    NENull |
    Falsy |
    IsUndefined,
  NullFacts = TypeofEQObject |
    TypeofNEString |
    TypeofNENumber |
    TypeofNEBigInt |
    TypeofNEBoolean |
    TypeofNESymbol |
    TypeofNEFunction |
    TypeofNEHostObject |
    EQNull |
    EQUndefinedOrNull |
    NEUndefined |
    Falsy |
    IsNull,
  EmptyObjectStrictFacts = All & ~(EQUndefined | EQNull | EQUndefinedOrNull | IsUndefinedOrNull),
  EmptyObjectFacts = All & ~IsUndefinedOrNull,
  UnknownFacts = All & ~IsUndefinedOrNull,
  AllTypeofNE = TypeofNEString |
    TypeofNENumber |
    TypeofNEBigInt |
    TypeofNEBoolean |
    TypeofNESymbol |
    TypeofNEObject |
    TypeofNEFunction |
    NEUndefined,
  OrFactsMask = TypeofEQFunction | TypeofNEObject,
  AndFactsMask = All & ~OrFactsMask,
}

export function getTypeFacts(c: Checker, t: Type, mask: TypeFacts): TypeFacts {
  return getTypeFactsWorker(c, t, mask) & mask;
}

export function hasTypeFacts(c: Checker, t: Type, mask: TypeFacts): boolean {
  return getTypeFacts(c, t, mask) !== 0;
}

function getTypeFactsWorker(c: Checker, t: Type, callerOnlyNeeds: TypeFacts): TypeFacts {
  if ((t.flags & (TypeFlags.Intersection | TypeFlags.Instantiable)) !== 0)
    t = getBaseConstraintOfType(c, t) ?? c.unknownType;
  const flags = t.flags;
  const strict = c.strictNullChecks;
  if ((flags & (TypeFlags.String | TypeFlags.StringMapping)) !== 0)
    return strict ? TypeFacts.StringStrictFacts : TypeFacts.StringFacts;
  if ((flags & (TypeFlags.StringLiteral | TypeFlags.TemplateLiteral)) !== 0) {
    const isEmpty = (flags & TypeFlags.StringLiteral) !== 0 && (t as LiteralType).stringValue === '';
    return strict
      ? isEmpty
        ? TypeFacts.EmptyStringStrictFacts
        : TypeFacts.NonEmptyStringStrictFacts
      : isEmpty
        ? TypeFacts.EmptyStringFacts
        : TypeFacts.NonEmptyStringFacts;
  }
  if ((flags & (TypeFlags.Number | TypeFlags.Enum)) !== 0)
    return strict ? TypeFacts.NumberStrictFacts : TypeFacts.NumberFacts;
  if ((flags & TypeFlags.NumberLiteral) !== 0) {
    const isZero = (t as LiteralType).numberValue === 0;
    return strict
      ? isZero
        ? TypeFacts.ZeroNumberStrictFacts
        : TypeFacts.NonZeroNumberStrictFacts
      : isZero
        ? TypeFacts.ZeroNumberFacts
        : TypeFacts.NonZeroNumberFacts;
  }
  if ((flags & TypeFlags.BigInt) !== 0) return strict ? TypeFacts.BigIntStrictFacts : TypeFacts.BigIntFacts;
  if ((flags & TypeFlags.BigIntLiteral) !== 0) {
    const isZero = (t as LiteralType).stringValue === '0';
    return strict
      ? isZero
        ? TypeFacts.ZeroBigIntStrictFacts
        : TypeFacts.NonZeroBigIntStrictFacts
      : isZero
        ? TypeFacts.ZeroBigIntFacts
        : TypeFacts.NonZeroBigIntFacts;
  }
  if ((flags & TypeFlags.Boolean) !== 0) return strict ? TypeFacts.BooleanStrictFacts : TypeFacts.BooleanFacts;
  if ((flags & TypeFlags.BooleanLike) !== 0) {
    const isFalse = t === c.falseType || t === c.regularFalseType;
    return strict
      ? isFalse
        ? TypeFacts.FalseStrictFacts
        : TypeFacts.TrueStrictFacts
      : isFalse
        ? TypeFacts.FalseFacts
        : TypeFacts.TrueFacts;
  }
  if ((flags & TypeFlags.Object) !== 0) {
    const possible = strict
      ? TypeFacts.EmptyObjectStrictFacts | TypeFacts.FunctionStrictFacts | TypeFacts.ObjectStrictFacts
      : TypeFacts.EmptyObjectFacts | TypeFacts.FunctionFacts | TypeFacts.ObjectFacts;
    // Skip resolving members when the caller can't use the result.
    if ((callerOnlyNeeds & possible) === 0) return TypeFacts.None;
    if ((t.objectFlags & ObjectFlags.Anonymous) !== 0 && isEmptyObjectType(c, t))
      return strict ? TypeFacts.EmptyObjectStrictFacts : TypeFacts.EmptyObjectFacts;
    if (isFunctionObjectType(c, t)) return strict ? TypeFacts.FunctionStrictFacts : TypeFacts.FunctionFacts;
    return strict ? TypeFacts.ObjectStrictFacts : TypeFacts.ObjectFacts;
  }
  if ((flags & TypeFlags.Void) !== 0) return TypeFacts.VoidFacts;
  if ((flags & TypeFlags.Undefined) !== 0) return TypeFacts.UndefinedFacts;
  if ((flags & TypeFlags.Null) !== 0) return TypeFacts.NullFacts;
  if ((flags & TypeFlags.ESSymbolLike) !== 0) return strict ? TypeFacts.SymbolStrictFacts : TypeFacts.SymbolFacts;
  if ((flags & TypeFlags.NonPrimitive) !== 0) return strict ? TypeFacts.ObjectStrictFacts : TypeFacts.ObjectFacts;
  if ((flags & TypeFlags.Never) !== 0) return TypeFacts.None;
  if ((flags & TypeFlags.Union) !== 0) {
    let facts = TypeFacts.None;
    for (const u of typesOf(t)) facts |= getTypeFactsWorker(c, u, callerOnlyNeeds);
    return facts;
  }
  if ((flags & TypeFlags.Intersection) !== 0) return getIntersectionTypeFacts(c, t, callerOnlyNeeds);
  return TypeFacts.UnknownFacts;
}

function getIntersectionTypeFacts(c: Checker, t: Type, callerOnlyNeeds: TypeFacts): TypeFacts {
  // With a primitive, object constituents are type tags and ignored.
  const ignoreObjects = maybeTypeOfKind(t, TypeFlags.Primitive);
  let ored = TypeFacts.None;
  let anded = TypeFacts.All;
  for (const u of typesOf(t)) {
    if (ignoreObjects && (u.flags & TypeFlags.Object) !== 0) continue;
    const f = getTypeFactsWorker(c, u, callerOnlyNeeds);
    ored |= f;
    anded &= f;
  }
  return (ored & TypeFacts.OrFactsMask) | (anded & TypeFacts.AndFactsMask);
}

function isFunctionObjectType(c: Checker, t: Type): boolean {
  if ((t.objectFlags & ObjectFlags.EvolvingArray) !== 0) return false;
  const resolved = resolveStructuredTypeMembers(c, t);
  return (
    resolved.callSignatures.length !== 0 ||
    resolved.constructSignatures.length !== 0 ||
    (getResolvedMember(resolved, 'bind') !== undefined && isTypeSubtypeOf(c, t, c.globalFunctionType))
  );
}

export function getTypeWithFacts(c: Checker, t: Type, include: TypeFacts): Type {
  // Filter non-unions without a closure (as filterType would).
  if ((t.flags & TypeFlags.Union) === 0)
    return (t.flags & TypeFlags.Never) !== 0 || hasTypeFacts(c, t, include) ? t : c.neverType;
  return filterType(c, t, (u) => hasTypeFacts(c, u, include));
}

/** Like getTypeWithFacts, but expands `unknown` and intersects instantiable types to remove nullables. */
export function getAdjustedTypeWithFacts(c: Checker, t: Type, facts: TypeFacts): Type {
  let reduced = getTypeWithFacts(
    c,
    c.strictNullChecks && (t.flags & TypeFlags.Unknown) !== 0 ? c.unknownUnionType : t,
    facts,
  );
  if (reduced === c.unknownUnionType) reduced = c.unknownType;
  if (!c.strictNullChecks) return reduced;
  switch (facts) {
    case TypeFacts.NEUndefined:
      return removeNullableByIntersection(
        c,
        reduced,
        TypeFacts.EQUndefined,
        TypeFacts.EQNull,
        TypeFacts.IsNull,
        c.nullType,
      );
    case TypeFacts.NENull:
      return removeNullableByIntersection(
        c,
        reduced,
        TypeFacts.EQNull,
        TypeFacts.EQUndefined,
        TypeFacts.IsUndefined,
        c.undefinedType,
      );
    case TypeFacts.NEUndefinedOrNull:
    case TypeFacts.Truthy:
      return mapType(c, reduced, (u) =>
        hasTypeFacts(c, u, TypeFacts.EQUndefinedOrNull) ? getGlobalNonNullableTypeInstantiation(c, u) : u,
      );
  }
  return reduced;
}

/** `NonNullable<T>`, or `T & {}` without the global alias. */
function getGlobalNonNullableTypeInstantiation(c: Checker, t: Type): Type {
  const alias = getGlobalTypeAliasSymbol(c, 'NonNullable', 1, false);
  return alias !== undefined
    ? getTypeAliasInstantiation(c, alias, [t], undefined)
    : getIntersectionType(c, [t, c.emptyObjectType]);
}

function removeNullableByIntersection(
  c: Checker,
  t: Type,
  targetFacts: TypeFacts,
  otherFacts: TypeFacts,
  otherIncludesFacts: TypeFacts,
  otherType: Type,
): Type {
  const facts = getTypeFacts(c, t, TypeFacts.EQUndefined | TypeFacts.EQNull | TypeFacts.IsUndefined | TypeFacts.IsNull);
  if ((facts & targetFacts) === 0) return t;
  const emptyAndOtherUnion = getUnionType(c, [c.emptyObjectType, otherType]);
  return mapType(c, t, (u) => {
    if (!hasTypeFacts(c, u, targetFacts)) return u;
    if ((facts & otherIncludesFacts) === 0 && hasTypeFacts(c, u, otherFacts))
      return getIntersectionType(c, [u, emptyAndOtherUnion]);
    return getIntersectionType(c, [u, c.emptyObjectType]);
  });
}

export function getNonNullableType(c: Checker, t: Type): Type {
  return c.strictNullChecks ? getAdjustedTypeWithFacts(c, t, TypeFacts.NEUndefinedOrNull) : t;
}
