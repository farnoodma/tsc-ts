// Members of types: resolving properties, signatures and index infos of object, union and
// intersection types; apparent types, reduced types and base constraints.
import type { Node } from './ast.js';
import { getCombinedModifierFlags, getDeclarationOfKind } from './binder-utilities.js';
import { Diagnostics } from './diagnostics.js';
import { ModifierFlags, getSymbol, MappedTypeNode, getName } from './ast.js';
import { CheckFlags, InternalSymbolName, type Symbol, SymbolFlags, type SymbolTable } from './symbol.js';
import { SyntaxKind } from './syntax-kind.js';
import type { Checker } from './checker.js';
import {
  CachedTypeKind,
  cachedTypeKey,
  CompositeSignature,
  ElementFlags,
  IndexInfo,
  type IndexType,
  type IndexedAccessType,
  type InterfaceType,
  type IntersectionType,
  type MappedType,
  ObjectFlags,
  type ObjectType,
  type Signature,
  SignatureFlags,
  SignatureKind,
  type StringMappingType,
  type StructuredType,
  type TemplateLiteralType,
  Ternary,
  type Type,
  TypeFlags,
  type TypeMapper,
  type TypeParameter,
  type TypeReference,
  type UnionOrIntersectionType,
  type UnionType,
  emptyIndexInfos,
  emptySignatures,
  emptySymbols,
  emptyTypes,
  newTypeMapper,
  prependTypeMapping,
  LiteralType,
  PendingMembers,
} from './checker-types.js';
import {
  UnionReduction,
  compareSymbols,
  createArrayTypeEx,
  createTupleTypeEx,
  createTypeReference,
  everyType,
  getElementTypes,
  getIntersectionType,
  getStringLiteralType,
  getTemplateLiteralType,
  getTypeArguments,
  getUnionOrIntersectionType,
  getUnionType,
  getUnionTypeEx,
  isArrayOrTupleType,
  isErrorType,
  isGenericTupleType,
  isLiteralType,
  isPatternLiteralType,
  isReadonlyArrayType,
  isTupleType,
  mapType,
  setStructuredTypeMembers,
  someType,
  tupleTargetOf,
  typesOf,
} from './checker-type-factory.js';
import { getRestTypeOfTupleType, mappedTypeTarget } from './checker-type-operators.js';
import { isAmbientModule } from './ast-utilities.js';
import {
  getExportsOfSymbol,
  getLateBoundSymbol,
  getMembersOfSymbol,
  getMergedSymbol,
  getNamedMembers,
  getSymbolOfDeclaration,
  isDeclarationContainedBy,
  isReservedMemberName,
  popTypeResolution,
  pushTypeResolution,
  symbolIsValue,
  TypeSystemPropertyName,
} from './checker-symbols.js';
import {
  getBaseConstructorTypeOfClass,
  getBaseTypes,
  getConstraintDeclaration,
  getConstraintFromTypeParameter,
  getDeclaredTypeOfClassOrInterface,
  getDeclaredTypeOfSymbol,
  getLocalTypeParametersOfClassOrInterfaceOrTypeAlias,
  isMixinConstructorType,
} from './checker-declared-types.js';
import { getTypeOfSymbol, getWriteTypeOfSymbol, isReadonlySymbol } from './checker-symbol-types.js';
import { getTypeFromTypeNode } from './checker-type-nodes.js';
import {
  instantiateIndexInfos,
  instantiateSignatures,
  instantiateSymbol,
  instantiateType,
  keepsSymbolUnderInstantiation,
  newInstantiatedSymbol,
  instantiateTypes,
} from './instantiation.js';
import {
  compareProperties,
  compareSignaturesIdentical,
  ComparerKind,
  compareTypesIdentical,
  getRecursionIdentity,
  isTypeAssignableTo,
  type RecursionId,
} from './relations.js';
import { typeToString } from './type-printer.js';
import {
  cloneSignature,
  createSignatureInstantiation,
  getDefaultConstructSignatures,
  getIndexInfosOfIndexSymbol,
  getMinArgumentCount,
  getParameterCount,
  getParameterNameAtPosition,
  getReturnTypeOfSignature,
  getSignaturesOfSymbol,
  getTypeAtPosition,
  hasEffectiveRestParameter,
  tryGetTypeAtPosition,
} from './checker-signatures.js';
import {
  getConstraintFromConditionalType,
  getHomomorphicTypeVariable,
  getIndexForMappedType,
  getIndexedAccessTypeOrUndefined,
  getModifiersTypeFromMappedType,
  getNameTypeFromMappedType,
  getSimplifiedType,
  getStringMappingType,
  getSubstitutionIntersection,
  isGenericMappedType,
  isMappedTypeGenericIndexedAccess,
  isMappedTypeWithKeyofConstraintDeclaration,
  resolveMappedTypeMembers,
  resolveReverseMappedTypeMembers,
  substituteIndexedMappedType,
} from './checker-type-operators.js';
import { getGlobalBigIntType, getGlobalESSymbolType } from './checker-globals.js';
import { isLateBoundName, isNumericLiteralName } from './checker-utilities.js';

// ---- Resolution

export function resolveStructuredTypeMembers(c: Checker, t: Type): StructuredType {
  if ((t.objectFlags & ObjectFlags.MembersResolved) === 0) {
    if ((t.flags & TypeFlags.Object) !== 0) {
      const objectFlags = t.objectFlags;
      if ((objectFlags & ObjectFlags.Reference) !== 0) resolveTypeReferenceMembers(c, t as TypeReference);
      else if ((objectFlags & ObjectFlags.ClassOrInterface) !== 0)
        resolveObjectTypeMembers(c, t as StructuredType, t as InterfaceType, emptyTypes, emptyTypes);
      else if ((objectFlags & ObjectFlags.ReverseMapped) !== 0) resolveReverseMappedTypeMembers(c, t);
      else if ((objectFlags & ObjectFlags.Anonymous) !== 0) resolveAnonymousTypeMembers(c, t as ObjectType);
      else if ((objectFlags & ObjectFlags.Mapped) !== 0) resolveMappedTypeMembers(c, t as MappedType);
    } else if ((t.flags & TypeFlags.Union) !== 0) resolveUnionTypeMembers(c, t as UnionType);
    else if ((t.flags & TypeFlags.Intersection) !== 0) resolveIntersectionTypeMembers(c, t as IntersectionType);
  }
  return t as StructuredType;
}

function resolveTypeReferenceMembers(c: Checker, t: TypeReference): void {
  const source = t.target as InterfaceType;
  const typeParameters = source.allTypeParameters;
  const typeArguments = getTypeArguments(c, t);
  let padded = typeArguments;
  if (typeArguments.length === typeParameters.length - 1) {
    // The reference itself is the `this` type argument.
    padded = typeArguments.slice();
    padded.push(t as Type);
  }
  resolveObjectTypeMembers(c, t, source, typeParameters, padded);
}

function sameTypes(a: readonly Type[], b: readonly Type[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i]! !== b[i]!) return false;
  return true;
}

function resolveObjectTypeMembers(
  c: Checker,
  t: StructuredType,
  source: InterfaceType,
  typeParameters: Type[],
  typeArguments: Type[],
): void {
  resolveDeclaredMembers(c, source);
  let mapper: TypeMapper | undefined;
  let members: SymbolTable | undefined;
  let callSignatures: Signature[];
  let constructSignatures: Signature[];
  let indexInfos: IndexInfo[];
  let instantiated = false;
  // The member symbols of an instantiation are instantiated on demand (PendingInstantiatedMembers).
  let pending: PendingInstantiatedMembers | undefined;
  if (sameTypes(typeParameters, typeArguments)) {
    members = source.declaredMembers;
    callSignatures = source.declaredCallSignatures;
    constructSignatures = source.declaredConstructSignatures;
    indexInfos = source.declaredIndexInfos;
  } else {
    instantiated = true;
    mapper = newTypeMapper(typeParameters, typeArguments);
    pending = pendingInstantiatedTable(c, source, mapper);
    members = pending === undefined ? instantiateSymbolTable(c, source.declaredMembers, mapper) : undefined;
    callSignatures = instantiateSignatures(c, source.declaredCallSignatures, mapper);
    constructSignatures = instantiateSignatures(c, source.declaredConstructSignatures, mapper);
    indexInfos = instantiateIndexInfos(c, source.declaredIndexInfos, mapper);
  }
  const baseTypes = getBaseTypes(c, source);
  // The declared type itself with base types: tsgo copies the declared members into a new table and
  // adds the inherited ones; that table is built on demand too.
  if (!instantiated && baseTypes.length !== 0) pending = pendingDeclaredTable(c, source);
  if (pending !== undefined) {
    resolvePendingObjectTypeMembers(
      c,
      t,
      pending,
      baseTypes,
      mapper,
      typeArguments,
      callSignatures,
      constructSignatures,
      indexInfos,
    );
    return;
  }
  if (baseTypes.length !== 0) {
    members = !instantiated || members === undefined ? new Map(members ?? []) : members;
    setStructuredTypeMembers(c, t, members, callSignatures, constructSignatures, indexInfos);
    const thisArgument = typeArguments.length !== 0 ? typeArguments[typeArguments.length - 1]! : undefined;
    t.objectFlags |= ObjectFlags.UnresolvedMembers;
    for (const baseType of baseTypes) {
      const instantiatedBaseType =
        thisArgument !== undefined
          ? getTypeWithThisArgument(c, instantiateType(c, baseType, mapper), thisArgument, false)
          : baseType;
      addInheritedMembers(members, getPropertiesOfType(c, instantiatedBaseType));
      callSignatures = callSignatures.concat(getSignaturesOfType(c, instantiatedBaseType, SignatureKind.Call));
      constructSignatures = constructSignatures.concat(
        getSignaturesOfType(c, instantiatedBaseType, SignatureKind.Construct),
      );
      const inherited =
        instantiatedBaseType !== c.anyType ? getIndexInfosOfType(c, instantiatedBaseType) : [c.anyBaseTypeIndexInfo];
      const added: IndexInfo[] = [];
      for (const info of inherited) if (findIndexInfo(indexInfos, info.keyType) === undefined) added.push(info);
      if (added.length !== 0) indexInfos = indexInfos.concat(added);
    }
    t.objectFlags &= ~ObjectFlags.UnresolvedMembers;
  }
  setStructuredTypeMembers(c, t, members, callSignatures, constructSignatures, indexInfos);
}

// ---- Lazily instantiated members
//
// tsgo instantiates every member symbol of a type reference or an anonymous type instantiation when
// it resolves the type's members, and copies the inherited ones into its members table; most of those
// symbols are never used. Here the type gets a PendingInstantiatedMembers instead, which instantiates
// a member when it is looked up by name and builds the table that tsgo would have built when
// `members` or `properties` is read. Everything that can create types (signatures, index infos,
// base types and their members) is still resolved eagerly and in tsgo's order, so type identities and
// ids are unchanged. Member symbols come out identical too: whether `instantiateSymbol` keeps a
// symbol depends on whether its type is resolved yet, so that decision is recorded at resolution.

// Two bits per member, in table order: whether tsgo puts it in the instantiated table, and whether
// `instantiateSymbol` keeps the symbol itself.
const enum MemberState {
  Skipped = 0,
  Instantiated = 1,
  Kept = 3,
}

/**
 * The properties of a pending table in order, as `properties` would hold them, without instantiating
 * members: property `i` is `symbols[i]` itself or, where `owners[i]` is set, the member of that pending
 * table instantiated from `symbols[i]`, which has the same name, flags, declarations and value
 * declaration (see propertyAt and propertyCheckFlagsAt).
 */
export class PropertyList {
  readonly symbols: Symbol[];
  readonly owners: (PendingInstantiatedMembers | undefined)[] | undefined;

  constructor(symbols: Symbol[], owners: (PendingInstantiatedMembers | undefined)[] | undefined) {
    this.symbols = symbols;
    this.owners = owners;
  }
}

export class PendingInstantiatedMembers extends PendingMembers {
  readonly c: Checker;
  /**
   * References: the declared members of the class or interface, by name. In a declared table (the
   * declared type of a class or interface with base types) these are the own members themselves.
   */
  readonly sourceTable: SymbolTable | undefined;
  /** Anonymous type instantiations: the properties of the target, in order. */
  readonly sourceList: Symbol[] | undefined;
  /** Undefined for a declared table, whose own members aren't instantiated. */
  readonly mapper: TypeMapper | undefined;
  /** MemberState of each member of the source, in order, 16 to a word. */
  readonly states: number[];
  /** Position of each member of the source by name (shared by all instantiations of the source). */
  readonly positions: Map<string, number>;
  /**
   * What a reference inherits, per base type as far as resolution has come: a base whose own pending
   * table is complete (its properties are read on demand), or else the base's properties as read when
   * tsgo reads them.
   */
  readonly baseTypes: (StructuredType | undefined)[];
  readonly baseProperties: (Symbol[] | undefined)[];
  /** Whether the type has base types (tsgo copies the instantiated table into a new one then). */
  hasBases: boolean;
  /** While the base types are resolved: `properties` holds the own members only, as in tsgo. */
  resolving: boolean;
  /** Members instantiated by name lookups so far. */
  instantiated: Map<string, Symbol> | undefined;
  /** Names that aren't own members, looked up after resolution, and what they found. */
  inheritedLookups: Map<string, Symbol | undefined> | undefined;
  /** The properties in order, built once resolution is complete (propertyList). */
  list: PropertyList | undefined;
  /** The members table once built; own members are read from it from then on. */
  table: SymbolTable | undefined;
  /** Whether the instantiated table has an own member, and one that isn't optional. */
  readonly hasOwnMembers: boolean;
  readonly hasRequiredOwnMembers: boolean;

  constructor(
    c: Checker,
    sourceTable: SymbolTable | undefined,
    sourceList: Symbol[] | undefined,
    mapper: TypeMapper | undefined,
    states: number[],
    positions: Map<string, number>,
    hasOwnMembers: boolean,
    hasRequiredOwnMembers: boolean,
  ) {
    super();
    this.hasOwnMembers = hasOwnMembers;
    this.hasRequiredOwnMembers = hasRequiredOwnMembers;
    this.c = c;
    this.sourceTable = sourceTable;
    this.sourceList = sourceList;
    this.mapper = mapper;
    this.states = states;
    this.positions = positions;
    this.baseTypes = [];
    this.baseProperties = [];
    this.hasBases = false;
    this.resolving = false;
    this.instantiated = undefined;
    this.inheritedLookups = undefined;
    this.list = undefined;
    this.table = undefined;
  }

  state(position: number): MemberState {
    return ((this.states[position >> 4]! >>> ((position & 15) * 2)) & 3) as MemberState;
  }

  /** The member symbol at `position` of the source, instantiated as tsgo would have. */
  memberAt(position: number, source: Symbol): Symbol {
    const name = source.name;
    const instantiated = this.instantiated;
    if (instantiated !== undefined) {
      const known = instantiated.get(name);
      if (known !== undefined) return known;
    }
    return this.state(position) === MemberState.Kept ? source : newInstantiatedSymbol(this.c, source, this.mapper!);
  }

  /** The own member `name` as in tsgo's instantiated (or copied) table, or undefined. */
  ownMember(name: string): Symbol | undefined {
    const table = this.table;
    if (table !== undefined) return table.get(name);
    if (this.mapper === undefined) return this.sourceTable?.get(name);
    const position = this.positions.get(name);
    if (position === undefined || this.state(position) === MemberState.Skipped) return undefined;
    let instantiated = this.instantiated;
    if (instantiated !== undefined) {
      const known = instantiated.get(name);
      if (known !== undefined) return known;
    }
    const source = this.sourceTable !== undefined ? this.sourceTable.get(name)! : this.sourceList![position]!;
    const symbol =
      this.state(position) === MemberState.Kept ? source : newInstantiatedSymbol(this.c, source, this.mapper);
    if (instantiated === undefined) this.instantiated = instantiated = new Map<string, Symbol>();
    instantiated.set(name, symbol);
    return symbol;
  }

  /** `members.get(name)` of the table tsgo would have built by now. */
  get(name: string): Symbol | undefined {
    let existing = this.ownMember(name);
    // Instantiated own members have value flags (pendingInstantiatedTable), so no base replaces
    // them; in a declared table only reserved names (signatures, index signatures) lack them.
    const baseTypes = this.baseTypes;
    if ((existing !== undefined && (existing.flags & SymbolFlags.Value) !== 0) || baseTypes.length === 0)
      return existing;
    // Once resolution is complete the answer for a name can't change: remember it.
    const cacheable = !this.resolving;
    let lookups = this.inheritedLookups;
    if (cacheable && lookups !== undefined) {
      const known = lookups.get(name);
      if (known !== undefined || lookups.has(name)) return known;
    }
    // addInheritedMembers: a base property replaces a missing or non-value member.
    for (let i = 0; i < baseTypes.length; i++) {
      if (existing !== undefined && (existing.flags & SymbolFlags.Value) !== 0) break;
      const base = baseTypes[i];
      const inherited =
        base !== undefined
          ? getInheritedProperty(this.c, base, name)
          : findProperty(this.c, this.baseProperties[i]!, name);
      if (inherited !== undefined && !isStaticPrivateIdentifierProperty(inherited)) existing = inherited;
    }
    if (cacheable) {
      if (lookups === undefined) this.inheritedLookups = lookups = new Map<string, Symbol | undefined>();
      lookups.set(name, existing);
    }
    return existing;
  }

  /**
   * A symbol with the name, flags and declarations of `get(name)`, without instantiating members:
   * the source of a pending own member, or what a base has under that name.
   */
  peek(name: string): Symbol | undefined {
    let existing: Symbol | undefined;
    if (this.table !== undefined) existing = this.table.get(name);
    else if (this.mapper === undefined) existing = this.sourceTable?.get(name);
    else {
      const position = this.positions.get(name);
      if (position !== undefined && this.state(position) !== MemberState.Skipped)
        existing =
          this.instantiated?.get(name) ??
          (this.sourceTable !== undefined ? this.sourceTable.get(name)! : this.sourceList![position]!);
    }
    const baseTypes = this.baseTypes;
    if ((existing !== undefined && (existing.flags & SymbolFlags.Value) !== 0) || baseTypes.length === 0)
      return existing;
    const lookups = this.inheritedLookups;
    if (!this.resolving && lookups !== undefined) {
      const known = lookups.get(name);
      if (known !== undefined || lookups.has(name)) return known;
    }
    for (let i = 0; i < baseTypes.length; i++) {
      if (existing !== undefined && (existing.flags & SymbolFlags.Value) !== 0) break;
      const base = baseTypes[i];
      const inherited =
        base !== undefined
          ? peekInheritedProperty(this.c, base, name)
          : findProperty(this.c, this.baseProperties[i]!, name);
      if (inherited !== undefined && !isStaticPrivateIdentifierProperty(inherited)) existing = inherited;
    }
    return existing;
  }

  /** The table of own members, as instantiateSymbolTable or createInstantiatedSymbolTable builds it. */
  ownTable(): SymbolTable {
    if (this.mapper === undefined) return new Map<string, Symbol>(this.sourceTable ?? []);
    const table = new Map<string, Symbol>();
    const list = this.sourceList;
    if (list !== undefined) {
      for (let i = 0; i < list.length; i++) {
        const source = list[i]!;
        // Of two properties with one name, the table keeps the last (and the lookups use it).
        table.set(
          source.name,
          this.positions.get(source.name) === i
            ? this.memberAt(i, source)
            : this.state(i) === MemberState.Kept
              ? source
              : newInstantiatedSymbol(this.c, source, this.mapper),
        );
      }
      return table;
    }
    let i = 0;
    for (const [id, source] of this.sourceTable!) {
      if (this.state(i) !== MemberState.Skipped) table.set(id, this.memberAt(i, source));
      i++;
    }
    return table;
  }

  materialize(t: StructuredType): void {
    const c = this.c;
    t.pendingMembers = undefined;
    const members = this.ownTable();
    this.table = members;
    this.list = undefined;
    this.instantiated = undefined;
    this.inheritedLookups = undefined;
    if (!this.hasBases) {
      t.membersValue = members;
      t.propertiesValue = getNamedMembers(c, members, t.symbol);
      return;
    }
    // While the bases are resolved, tsgo's `properties` holds the own members and its table
    // grows by each base as it is resolved; the rest of resolution continues eagerly.
    const ownProperties = this.resolving ? getNamedMembers(c, members, t.symbol) : undefined;
    const baseTypes = this.baseTypes;
    for (let i = 0; i < baseTypes.length; i++) {
      const base = baseTypes[i];
      addInheritedMembers(members, base !== undefined ? base.properties : this.baseProperties[i]!);
    }
    t.membersValue = members;
    t.propertiesValue = ownProperties ?? getNamedMembers(c, members, t.symbol);
  }

  /**
   * The properties of `t` (whose pending table this is, resolution complete) in the order of
   * `t.properties`, without instantiating members: the table materialize would build, with
   * getNamedMembers' filter and order applied to the source symbols. An instantiated member has the
   * name, flags and declarations of its source, which is all that the order depends on (names are
   * distinct, so compareSymbols never falls back to symbol ids).
   */
  propertyList(t: StructuredType): PropertyList {
    const known = this.list;
    if (known !== undefined) return known;
    const c = this.c;
    const symbols: Symbol[] = [];
    const owners: (PendingInstantiatedMembers | undefined)[] = [];
    let hasOwners = false;
    const baseTypes = this.baseTypes;
    const list = this.sourceList;
    // Positions by name, needed only where an entry can replace an earlier one: inherited members,
    // and properties of a list that share a name.
    const index: Map<string, number> | undefined =
      baseTypes.length !== 0 || (list !== undefined && this.positions.size !== list.length)
        ? new Map<string, number>()
        : undefined;
    if (this.mapper === undefined) {
      if (this.sourceTable !== undefined)
        for (const [id, source] of this.sourceTable) {
          index?.set(id, symbols.length);
          symbols.push(source);
          owners.push(undefined);
        }
    } else if (list !== undefined) {
      for (let i = 0; i < list.length; i++) {
        const source = list[i]!;
        const owner = this.state(i) === MemberState.Kept ? undefined : this;
        if (owner !== undefined) hasOwners = true;
        const at = index?.get(source.name);
        if (at === undefined) {
          index?.set(source.name, symbols.length);
          symbols.push(source);
          owners.push(owner);
        } else {
          symbols[at] = source;
          owners[at] = owner;
        }
      }
    } else {
      let i = 0;
      for (const [id, source] of this.sourceTable!) {
        const state = this.state(i++);
        if (state === MemberState.Skipped) continue;
        index?.set(id, symbols.length);
        symbols.push(source);
        if (state !== MemberState.Kept) hasOwners = true;
        owners.push(state === MemberState.Kept ? undefined : this);
      }
    }
    // addInheritedMembers for each base, in order.
    for (let b = 0; b < baseTypes.length; b++) {
      const base = baseTypes[b];
      const inherited =
        base !== undefined ? getPropertyListOfResolvedType(base) : new PropertyList(this.baseProperties[b]!, undefined);
      for (let i = 0; i < inherited.symbols.length; i++) {
        const symbol = inherited.symbols[i]!;
        if (isStaticPrivateIdentifierProperty(symbol)) continue;
        const owner = inherited.owners !== undefined ? inherited.owners[i] : undefined;
        const at = index!.get(symbol.name);
        if (at === undefined) {
          index!.set(symbol.name, symbols.length);
          symbols.push(symbol);
          owners.push(owner);
          if (owner !== undefined) hasOwners = true;
        } else if ((symbols[at]!.flags & SymbolFlags.Value) === 0) {
          symbols[at] = symbol;
          owners[at] = owner;
          if (owner !== undefined) hasOwners = true;
        }
      }
    }
    // getNamedMembers: value members whose names aren't reserved, those declared in the class or
    // interface first, each part in declaration order. Usually that is the order they are in.
    const container = t.symbol;
    const isClassOrInterface =
      container !== undefined && (container.flags & (SymbolFlags.Class | SymbolFlags.Interface)) !== 0;
    let inOrder = true;
    let lastPart = 0;
    for (let i = 0; i < symbols.length; i++) {
      const symbol = symbols[i]!;
      if (isReservedMemberName(symbol.name) || !symbolIsValue(c, symbol)) {
        inOrder = false;
        break;
      }
      const part = isClassOrInterface && isDeclarationContainedBy(symbol, container!) ? 0 : 1;
      if (part < lastPart || (i !== 0 && part === lastPart && compareSymbols(c, symbols[i - 1]!, symbol) > 0)) {
        inOrder = false;
        break;
      }
      lastPart = part;
    }
    let result: PropertyList;
    if (inOrder) result = new PropertyList(symbols, hasOwners ? owners : undefined);
    else {
      const contained: number[] = [];
      const rest: number[] = [];
      for (let i = 0; i < symbols.length; i++) {
        const symbol = symbols[i]!;
        if (isReservedMemberName(symbol.name) || !symbolIsValue(c, symbol)) continue;
        if (isClassOrInterface && isDeclarationContainedBy(symbol, container!)) contained.push(i);
        else rest.push(i);
      }
      sortSymbolPositions(c, symbols, contained);
      sortSymbolPositions(c, symbols, rest);
      let orderedHasOwners = false;
      const orderedSymbols: Symbol[] = [];
      const orderedOwners: (PendingInstantiatedMembers | undefined)[] = [];
      for (const part of [contained, rest])
        for (const i of part) {
          orderedSymbols.push(symbols[i]!);
          const owner = owners[i];
          orderedOwners.push(owner);
          if (owner !== undefined) orderedHasOwners = true;
        }
      result = new PropertyList(orderedSymbols, orderedHasOwners ? orderedOwners : undefined);
    }
    this.list = result;
    return result;
  }
}

/** Sorts positions into `symbols` as sortSymbols sorts the symbols at them. */
function sortSymbolPositions(c: Checker, symbols: Symbol[], positions: number[]): void {
  for (let i = 1; i < positions.length; i++)
    if (compareSymbols(c, symbols[positions[i - 1]!]!, symbols[positions[i]!]!) > 0) {
      positions.sort((a, b) => compareSymbols(c, symbols[a]!, symbols[b]!));
      return;
    }
}

/** The properties of a type whose members are resolved, as a PropertyList. */
function getPropertyListOfResolvedType(t: StructuredType): PropertyList {
  const pending = t.pendingMembers as PendingInstantiatedMembers | undefined;
  if (pending !== undefined && !pending.resolving) return pending.propertyList(t);
  return new PropertyList(t.properties, undefined);
}

/**
 * getPropertiesOfType, except that a complete pending table gives the source symbols of its
 * PropertyList; `c.propertyOwners` is then their owners, and undefined otherwise. Read it right after
 * the call, and use propertyAt and propertyCheckFlagsAt for what differs from the source symbol.
 */
export function getPropertySourcesOfType(c: Checker, t: Type): Symbol[] {
  t = getReducedApparentType(c, t);
  if ((t.flags & TypeFlags.UnionOrIntersection) !== 0) {
    // Computing these properties walks the constituents, which sets c.propertyOwners.
    const properties = getPropertiesOfUnionOrIntersectionType(c, t as UnionOrIntersectionType);
    c.propertyOwners = undefined;
    return properties;
  }
  return getPropertySourcesOfObjectType(c, t);
}

/** getPropertiesOfObjectType as getPropertySourcesOfType returns them. */
export function getPropertySourcesOfObjectType(c: Checker, t: Type): Symbol[] {
  if ((t.flags & TypeFlags.Object) === 0) {
    c.propertyOwners = undefined;
    return emptySymbols;
  }
  const resolved = resolveStructuredTypeMembers(c, t);
  const pending = resolved.pendingMembers as PendingInstantiatedMembers | undefined;
  if (pending !== undefined && !pending.resolving) {
    const list = pending.propertyList(resolved);
    c.propertyOwners = list.owners;
    return list.symbols;
  }
  const properties = resolved.properties;
  c.propertyOwners = undefined;
  return properties;
}

/** Property `i` of what getPropertySourcesOfType returned with `owners`, instantiated if pending. */
export function propertyAt(sources: Symbol[], owners: (PendingMembers | undefined)[] | undefined, i: number): Symbol {
  const source = sources[i]!;
  if (owners !== undefined) {
    const owner = owners[i] as PendingInstantiatedMembers | undefined;
    if (owner !== undefined) return owner.ownMember(source.name)!;
  }
  return source;
}

/** The check flags of propertyAt(sources, owners, i), without instantiating it. */
export function propertyCheckFlagsAt(
  sources: Symbol[],
  owners: (PendingMembers | undefined)[] | undefined,
  i: number,
): CheckFlags {
  const flags = sources[i]!.checkFlags;
  // An instantiated symbol takes these flags from its source (newInstantiatedSymbol).
  return owners !== undefined && owners[i] !== undefined
    ? CheckFlags.Instantiated |
        (flags & (CheckFlags.Readonly | CheckFlags.Late | CheckFlags.OptionalParameter | CheckFlags.RestParameter))
    : flags;
}

/**
 * The pending table of `table` instantiated with `mapper`, or undefined where it isn't worth it or
 * tsgo's table wouldn't be keyed by symbol names. Records the decisions instantiateSymbolTable makes.
 */
function pendingInstantiatedTable(
  c: Checker,
  source: InterfaceType,
  mapper: TypeMapper,
): PendingInstantiatedMembers | undefined {
  const table = source.declaredMembers;
  if (table === undefined || table.size === 0) return undefined;
  const states: number[] = [];
  let word = 0;
  let i = 0;
  let hasOwnMembers = false;
  let hasRequiredOwnMembers = false;
  for (const [id, symbol] of table) {
    if (id !== symbol.name) return undefined;
    let state = MemberState.Skipped;
    if (isNamedMember(c, symbol, id)) {
      // A named member without a value flag (an alias) could be replaced by an inherited one; keep
      // such tables eager, so that an own member always stands.
      if ((symbol.flags & SymbolFlags.Value) === 0) return undefined;
      state = keepsSymbolUnderInstantiation(c, symbol, mapper) ? MemberState.Kept : MemberState.Instantiated;
      // Instantiated symbols have the flags of their source.
      hasOwnMembers = true;
      if ((symbol.flags & SymbolFlags.Optional) === 0) hasRequiredOwnMembers = true;
    }
    word |= state << ((i & 15) * 2);
    if ((i & 15) === 15) {
      states.push(word);
      word = 0;
    }
    i++;
  }
  if ((i & 15) !== 0) states.push(word);
  return new PendingInstantiatedMembers(
    c,
    table,
    undefined,
    mapper,
    states,
    declaredMemberPositions(source, table),
    hasOwnMembers,
    hasRequiredOwnMembers,
  );
}

/**
 * The pending table of the declared type of `source` with base types, or undefined where a member
 * that would be a property lacks a value flag (an inherited property could replace it).
 */
function pendingDeclaredTable(c: Checker, source: InterfaceType): PendingInstantiatedMembers | undefined {
  const table = source.declaredMembers;
  let hasOwnMembers = false;
  let hasRequiredOwnMembers = false;
  if (table !== undefined)
    for (const [id, symbol] of table) {
      if (id !== symbol.name) return undefined;
      if (isReservedMemberName(id)) continue;
      if ((symbol.flags & SymbolFlags.Value) === 0) return undefined;
      hasOwnMembers = true;
      if ((symbol.flags & SymbolFlags.Optional) === 0) hasRequiredOwnMembers = true;
    }
  return new PendingInstantiatedMembers(
    c,
    table,
    undefined,
    undefined,
    emptyStates,
    new Map<string, number>(),
    hasOwnMembers,
    hasRequiredOwnMembers,
  );
}

const emptyStates: number[] = [];

/** The pending table of the properties `list` instantiated with `mapper` (createInstantiatedSymbolTable). */
function pendingInstantiatedList(c: Checker, list: Symbol[], mapper: TypeMapper): PendingInstantiatedMembers {
  const states: number[] = [];
  let word = 0;
  let hasRequiredOwnMembers = false;
  for (let i = 0; i < list.length; i++) {
    const state = keepsSymbolUnderInstantiation(c, list[i]!, mapper) ? MemberState.Kept : MemberState.Instantiated;
    if ((list[i]!.flags & SymbolFlags.Optional) === 0) hasRequiredOwnMembers = true;
    word |= state << ((i & 15) * 2);
    if ((i & 15) === 15) {
      states.push(word);
      word = 0;
    }
  }
  if ((list.length & 15) !== 0) states.push(word);
  return new PendingInstantiatedMembers(
    c,
    undefined,
    list,
    mapper,
    states,
    listPositions(c, list),
    true,
    hasRequiredOwnMembers,
  );
}

/** Positions of the declared members of `source` by name, shared by all its instantiations. */
function declaredMemberPositions(source: InterfaceType, table: SymbolTable): Map<string, number> {
  let positions = source.declaredMemberPositions;
  if (positions === undefined) {
    positions = new Map<string, number>();
    let i = 0;
    for (const id of table.keys()) positions.set(id, i++);
    source.declaredMemberPositions = positions;
  }
  return positions;
}

/** Positions by name in a target's properties, shared by its instantiations. The last of equal names wins. */
function listPositions(c: Checker, list: Symbol[]): Map<string, number> {
  let positions = c.memberPositionsInLists.get(list);
  if (positions === undefined) {
    positions = new Map<string, number>();
    let i = 0;
    for (const symbol of list) positions.set(symbol.name, i++);
    c.memberPositionsInLists.set(list, positions);
  }
  return positions;
}

/** The property `name` of a base whose pending table is complete, without building that table. */
function getInheritedProperty(c: Checker, base: StructuredType, name: string): Symbol | undefined {
  // getNamedMembers: properties are the value members whose names aren't reserved.
  if (isReservedMemberName(name)) return undefined;
  const symbol = getResolvedMember(base, name);
  return symbol !== undefined && symbolIsValue(c, symbol) ? symbol : undefined;
}

/** getInheritedProperty, without instantiating a pending member of the base. */
function peekInheritedProperty(c: Checker, base: StructuredType, name: string): Symbol | undefined {
  if (isReservedMemberName(name)) return undefined;
  const pending = base.pendingMembers as PendingInstantiatedMembers | undefined;
  const symbol = pending !== undefined ? pending.peek(name) : base.membersValue?.get(name);
  return symbol !== undefined && symbolIsValue(c, symbol) ? symbol : undefined;
}

/**
 * `getPropertyOfType(c, t, name) !== undefined`, without instantiating the member of a pending table
 * that it would return.
 */
export function hasPropertyOfType(c: Checker, t: Type, name: string): boolean {
  const reduced = getReducedApparentType(c, t);
  if ((reduced.flags & TypeFlags.Object) === 0) return getPropertyOfType(c, t, name) !== undefined;
  // getPropertyOfTypeEx for an object type.
  const resolved = resolveStructuredTypeMembers(c, reduced);
  const pending = resolved.pendingMembers as PendingInstantiatedMembers | undefined;
  const symbol = pending !== undefined ? pending.peek(name) : resolved.membersValue?.get(name);
  if (symbol !== undefined && symbolIsValue(c, symbol)) return true;
  let functionType: Type | undefined;
  if (reduced === c.anyFunctionType) functionType = c.globalFunctionType;
  else if (resolved.callSignatures.length !== 0) functionType = c.globalCallableFunctionType;
  else if (resolved.constructSignatures.length !== 0) functionType = c.globalNewableFunctionType;
  if (functionType !== undefined && getPropertyOfObjectType(c, functionType, name) !== undefined) return true;
  return getPropertyOfObjectType(c, c.globalObjectType, name) !== undefined;
}

/** The symbol named `name` in a list of properties. Long lists are indexed once. */
function findProperty(c: Checker, properties: Symbol[], name: string): Symbol | undefined {
  if (properties.length < 16) {
    for (const p of properties) if (p.name === name) return p;
    return undefined;
  }
  let byName = c.propertiesByName.get(properties);
  if (byName === undefined) {
    byName = new Map<string, Symbol>();
    for (const p of properties) if (!byName.has(p.name)) byName.set(p.name, p);
    c.propertiesByName.set(properties, byName);
  }
  return byName.get(name);
}

/** `t.members?.get(name)` of a type whose members are resolved, without building a pending table. */
export function getResolvedMember(t: StructuredType, name: string): Symbol | undefined {
  const pending = t.pendingMembers;
  if (pending !== undefined) return (pending as PendingInstantiatedMembers).get(name);
  return t.membersValue?.get(name);
}

/** `t.properties.length !== 0` of a type whose members are resolved, without building a pending table. */
export function hasResolvedProperties(t: StructuredType): boolean {
  const pending = t.pendingMembers as PendingInstantiatedMembers | undefined;
  if (pending !== undefined && !pending.resolving) {
    // Own members are all properties; with none, what the bases add decides.
    return pending.hasOwnMembers || pending.propertyList(t).symbols.length !== 0;
  }
  return t.properties.length !== 0;
}

/** `getPropertiesOfType(c, t).length !== 0`, without building a pending table. */
export function hasPropertiesOfType(c: Checker, t: Type): boolean {
  t = getReducedApparentType(c, t);
  if ((t.flags & TypeFlags.UnionOrIntersection) !== 0)
    return getPropertiesOfUnionOrIntersectionType(c, t as UnionOrIntersectionType).length !== 0;
  return (t.flags & TypeFlags.Object) !== 0 && hasResolvedProperties(resolveStructuredTypeMembers(c, t));
}

/**
 * `t.properties.every(p => p is optional)` of a type whose members are resolved and that has
 * properties, without building a pending table where its own members decide.
 */
export function resolvedPropertiesAreOptional(t: StructuredType): boolean {
  const pending = t.pendingMembers as PendingInstantiatedMembers | undefined;
  if (pending !== undefined && !pending.resolving) {
    // A required own member is in the table whatever the bases add.
    if (pending.hasRequiredOwnMembers) return false;
    if (!pending.hasBases) return true;
    const list = pending.propertyList(t);
    for (const p of list.symbols) if ((p.flags & SymbolFlags.Optional) === 0) return false;
    return true;
  }
  return t.properties.every((p) => (p.flags & SymbolFlags.Optional) !== 0);
}

/** resolveObjectTypeMembers for an instantiation whose member symbols are instantiated on demand. */
function resolvePendingObjectTypeMembers(
  c: Checker,
  t: StructuredType,
  pending: PendingInstantiatedMembers,
  baseTypes: Type[],
  mapper: TypeMapper | undefined,
  typeArguments: Type[],
  callSignatures: Signature[],
  constructSignatures: Signature[],
  indexInfos: IndexInfo[],
): void {
  setPendingStructuredTypeMembers(t, pending, callSignatures, constructSignatures, indexInfos);
  if (baseTypes.length === 0) return;
  pending.hasBases = true;
  pending.resolving = true;
  const thisArgument = typeArguments.length !== 0 ? typeArguments[typeArguments.length - 1]! : undefined;
  t.objectFlags |= ObjectFlags.UnresolvedMembers;
  for (const baseType of baseTypes) {
    const instantiatedBaseType =
      thisArgument !== undefined
        ? getTypeWithThisArgument(c, instantiateType(c, baseType, mapper), thisArgument, false)
        : baseType;
    // getPropertiesOfType, except that a base whose pending table is complete keeps it pending:
    // resolving its members has created every type already, and its table won't change. The
    // reduced apparent type of an object type is itself except for mapped types, whose apparent
    // type getPropertiesOfType computes first.
    let lazyBase: StructuredType | undefined;
    if (
      (instantiatedBaseType.flags & TypeFlags.Object) !== 0 &&
      (instantiatedBaseType.objectFlags & ObjectFlags.Mapped) === 0
    ) {
      const resolved = resolveStructuredTypeMembers(c, instantiatedBaseType);
      const basePending = resolved.pendingMembers;
      if (basePending !== undefined && !(basePending as PendingInstantiatedMembers).resolving) lazyBase = resolved;
    }
    const baseProperties = lazyBase === undefined ? getPropertiesOfType(c, instantiatedBaseType) : undefined;
    if (t.pendingMembers === pending) {
      pending.baseTypes.push(lazyBase);
      pending.baseProperties.push(baseProperties);
    } else addInheritedMembers(t.membersValue!, baseProperties ?? lazyBase!.properties);
    callSignatures = callSignatures.concat(getSignaturesOfType(c, instantiatedBaseType, SignatureKind.Call));
    constructSignatures = constructSignatures.concat(
      getSignaturesOfType(c, instantiatedBaseType, SignatureKind.Construct),
    );
    const inherited =
      instantiatedBaseType !== c.anyType ? getIndexInfosOfType(c, instantiatedBaseType) : [c.anyBaseTypeIndexInfo];
    const added: IndexInfo[] = [];
    for (const info of inherited) if (findIndexInfo(indexInfos, info.keyType) === undefined) added.push(info);
    if (added.length !== 0) indexInfos = indexInfos.concat(added);
  }
  t.objectFlags &= ~ObjectFlags.UnresolvedMembers;
  pending.resolving = false;
  if (t.pendingMembers === pending)
    setPendingStructuredTypeMembers(t, pending, callSignatures, constructSignatures, indexInfos);
  else setStructuredTypeMembers(c, t, t.membersValue, callSignatures, constructSignatures, indexInfos);
}

function setPendingStructuredTypeMembers(
  t: StructuredType,
  pending: PendingInstantiatedMembers,
  callSignatures: Signature[],
  constructSignatures: Signature[],
  indexInfos: IndexInfo[],
): void {
  t.objectFlags |= ObjectFlags.MembersResolved;
  t.membersValue = undefined;
  t.propertiesValue = emptySymbols;
  t.pendingMembers = pending;
  t.callSignatures = callSignatures;
  t.constructSignatures = constructSignatures;
  t.indexInfos = indexInfos;
}

export function findIndexInfo(indexInfos: readonly IndexInfo[], keyType: Type): IndexInfo | undefined {
  for (const info of indexInfos) if (info.keyType === keyType) return info;
  return undefined;
}

export function resolveDeclaredMembers(c: Checker, t: InterfaceType): InterfaceType {
  if (!t.declaredMembersResolved) {
    const members = getMembersOfSymbol(c, t.symbol!);
    t.declaredMembersResolved = true;
    t.declaredMembers = members;
    t.declaredCallSignatures = getSignaturesOfSymbol(c, members.get(InternalSymbolName.Call));
    t.declaredConstructSignatures = getSignaturesOfSymbol(c, members.get(InternalSymbolName.New));
    t.declaredIndexInfos = getIndexInfosOfSymbol(c, t.symbol!);
  }
  return t;
}

export function getIndexSymbol(c: Checker, symbol: Symbol): Symbol | undefined {
  return getMembersOfSymbol(c, symbol).get(InternalSymbolName.Index);
}

export function getIndexInfosOfSymbol(c: Checker, symbol: Symbol): IndexInfo[] {
  const indexSymbol = getIndexSymbol(c, symbol);
  if (indexSymbol === undefined) return emptyIndexInfos;
  return getIndexInfosOfIndexSymbol(c, indexSymbol, [...getMembersOfSymbol(c, symbol).values()]);
}

function isStaticPrivateIdentifierProperty(symbol: Symbol): boolean {
  const d = symbol.valueDeclaration;
  if (d === undefined) return false;
  const name = getName(d);
  return (
    name !== undefined &&
    name.kind === SyntaxKind.PrivateIdentifier &&
    (getCombinedModifierFlags(d) & ModifierFlags.Static) !== 0
  );
}

export function addInheritedMembers(symbols: SymbolTable, baseSymbols: readonly Symbol[]): void {
  for (const base of baseSymbols) {
    if (isStaticPrivateIdentifierProperty(base)) continue;
    const existing = symbols.get(base.name);
    if (existing === undefined || (existing.flags & SymbolFlags.Value) === 0) symbols.set(base.name, base);
  }
}

export function instantiateSymbolTable(
  c: Checker,
  symbols: SymbolTable | undefined,
  mapper: TypeMapper,
): SymbolTable | undefined {
  if (symbols === undefined || symbols.size === 0) return undefined;
  const result = new Map<string, Symbol>();
  for (const [id, symbol] of symbols)
    if (isNamedMember(c, symbol, id)) result.set(id, instantiateSymbol(c, symbol, mapper));
  return result;
}

export function isNamedMember(c: Checker, symbol: Symbol, id: string): boolean {
  if (id.length >= 2 && id.charCodeAt(0) === 0xfffe) {
    const second = id.charCodeAt(1);
    if (second !== 0x40 && second !== 0x23) return false;
  }
  return symbolIsValue(c, symbol);
}

function createInstantiatedSymbolTable(
  c: Checker,
  symbols: readonly Symbol[],
  mapper: TypeMapper | undefined,
): SymbolTable | undefined {
  if (symbols.length === 0) return undefined;
  const result = new Map<string, Symbol>();
  for (const symbol of symbols)
    result.set(symbol.name, mapper !== undefined ? instantiateSymbol(c, symbol, mapper) : symbol);
  return result;
}

function resolveAnonymousTypeMembers(c: Checker, t: ObjectType): void {
  if (t.target !== undefined) {
    setStructuredTypeMembers(c, t, undefined, emptySignatures, emptySignatures, emptyIndexInfos);
    const target = t.target;
    // createInstantiatedSymbolTable, on demand (PendingInstantiatedMembers).
    const targetProperties = getPropertiesOfObjectType(c, target);
    const pending =
      targetProperties.length !== 0 && t.mapper !== undefined
        ? pendingInstantiatedList(c, targetProperties, t.mapper)
        : undefined;
    const members = pending === undefined ? createInstantiatedSymbolTable(c, targetProperties, t.mapper) : undefined;
    const callSignatures = instantiateSignatures(c, getSignaturesOfType(c, target, SignatureKind.Call), t.mapper!);
    const constructSignatures = instantiateSignatures(
      c,
      getSignaturesOfType(c, target, SignatureKind.Construct),
      t.mapper!,
    );
    const indexInfos = instantiateIndexInfos(c, getIndexInfosOfType(c, target), t.mapper!);
    if (pending !== undefined)
      setPendingStructuredTypeMembers(t, pending, callSignatures, constructSignatures, indexInfos);
    else setStructuredTypeMembers(c, t, members, callSignatures, constructSignatures, indexInfos);
    return;
  }
  const symbol = getMergedSymbol(c, t.symbol!);
  if ((symbol.flags & SymbolFlags.TypeLiteral) !== 0) {
    setStructuredTypeMembers(c, t, undefined, emptySignatures, emptySignatures, emptyIndexInfos);
    const members = getMembersOfSymbol(c, symbol);
    const callSignatures = getSignaturesOfSymbol(c, members.get(InternalSymbolName.Call));
    const constructSignatures = getSignaturesOfSymbol(c, members.get(InternalSymbolName.New));
    const indexInfos = getIndexInfosOfSymbol(c, symbol);
    setStructuredTypeMembers(c, t, members, callSignatures, constructSignatures, indexInfos);
    return;
  }
  // Combinations of function, class, enum and module.
  let members = getExportsOfSymbol(c, symbol);
  if (symbol === c.globalThisSymbol) {
    const varsOnly = new Map<string, Symbol>();
    for (const p of members.values()) {
      if ((p.flags & SymbolFlags.BlockScoped) !== 0) continue;
      if ((p.flags & SymbolFlags.ValueModule) !== 0 && isOnlyAmbientModuleDeclarations(p.declarations)) continue;
      varsOnly.set(p.name, p);
    }
    members = varsOnly;
  }
  let baseConstructorIndexInfo: IndexInfo | undefined;
  setStructuredTypeMembers(c, t, members, emptySignatures, emptySignatures, emptyIndexInfos);
  if ((symbol.flags & SymbolFlags.Class) !== 0) {
    const classType = getDeclaredTypeOfClassOrInterface(c, symbol);
    const baseConstructorType = getBaseConstructorTypeOfClass(c, classType);
    if ((baseConstructorType.flags & (TypeFlags.Object | TypeFlags.Intersection | TypeFlags.TypeVariable)) !== 0) {
      members = new Map(members);
      addInheritedMembers(members, getPropertiesOfType(c, baseConstructorType));
      setStructuredTypeMembers(c, t, members, emptySignatures, emptySignatures, emptyIndexInfos);
    } else if (baseConstructorType === c.anyType) baseConstructorIndexInfo = c.anyBaseTypeIndexInfo;
  }
  let indexInfos: IndexInfo[] = [];
  const indexSymbol = members.get(InternalSymbolName.Index);
  if (indexSymbol !== undefined) indexInfos = getIndexInfosOfIndexSymbol(c, indexSymbol, [...members.values()]);
  else {
    if (baseConstructorIndexInfo !== undefined) indexInfos.push(baseConstructorIndexInfo);
    if ((symbol.flags & SymbolFlags.Enum) !== 0) {
      let numberLike = (getDeclaredTypeOfSymbol(c, symbol).flags & TypeFlags.Enum) !== 0;
      if (!numberLike)
        for (const prop of t.properties)
          if ((getTypeOfSymbol(c, prop).flags & TypeFlags.NumberLike) !== 0) {
            numberLike = true;
            break;
          }
      if (numberLike) indexInfos.push(c.enumNumberIndexInfo);
    }
  }
  t.indexInfos = indexInfos;
  // Members are resolved before signatures, which may use `typeof` on this type (#6072).
  if ((symbol.flags & (SymbolFlags.Function | SymbolFlags.Method)) !== 0)
    t.callSignatures = getSignaturesOfSymbol(c, symbol);
  if ((symbol.flags & SymbolFlags.Class) !== 0) {
    const classType = getDeclaredTypeOfClassOrInterface(c, symbol);
    let constructSignatures = getSignaturesOfSymbol(c, symbol.members?.get(InternalSymbolName.Constructor));
    if (constructSignatures.length === 0) constructSignatures = getDefaultConstructSignatures(c, classType);
    t.constructSignatures = constructSignatures;
  }
}

function isOnlyAmbientModuleDeclarations(declarations: readonly Node[]): boolean {
  if (declarations.length === 0) return false;
  for (const d of declarations) if (d.kind !== SyntaxKind.ModuleDeclaration || !isAmbientModule(d)) return false;
  return true;
}

function resolveUnionTypeMembers(c: Checker, t: UnionType): void {
  // Members and properties are empty for unions; getPropertiesOfType computes them.
  const callLists: Signature[][] = [];
  const constructLists: Signature[][] = [];
  for (const u of t.types) {
    callLists.push(u === c.globalFunctionType ? [c.unknownSignature] : getSignaturesOfType(c, u, SignatureKind.Call));
    constructLists.push(getSignaturesOfType(c, u, SignatureKind.Construct));
  }
  let callSignatures = getUnionSignatures(c, callLists);
  if (callSignatures.length === 0) callSignatures = getArrayMemberCallSignatures(c, t);
  const constructSignatures = getUnionSignatures(c, constructLists);
  const indexInfos = getUnionIndexInfos(c, t.types);
  setStructuredTypeMembers(c, t, undefined, callSignatures, constructSignatures, indexInfos);
}

function getArrayMemberCallSignatures(c: Checker, t: UnionType): Signature[] {
  // A union of instantiations of one Array or ReadonlyArray member: `(A[] | B[])["m"]` is `(A | B)[]["m"]`.
  let memberName = '';
  for (let i = 0; i < t.types.length; i++) {
    const u = t.types[i]!;
    if (
      (u.objectFlags & ObjectFlags.Instantiated) === 0 ||
      u.symbol === undefined ||
      u.symbol.parent === undefined ||
      !isArrayOrTupleSymbol(c, u.symbol.parent)
    )
      return emptySignatures;
    if (i === 0) memberName = u.symbol.name;
    else if (memberName !== u.symbol.name) return emptySignatures;
  }
  const arrayArg = mapType(c, t, (u) => {
    const generic = isReadonlyArraySymbol(c, u.symbol!.parent!) ? c.globalReadonlyArrayType : c.globalArrayType;
    return (u as ObjectType).mapper!.map((generic as InterfaceType).typeParameters()[0]!);
  });
  const arrayType = createArrayTypeEx(
    c,
    arrayArg,
    someType(t, (u) => isReadonlyArraySymbol(c, u.symbol!.parent!)),
  );
  const memberType = getTypeOfPropertyOfType(c, arrayType, memberName);
  return memberType !== undefined ? getSignaturesOfType(c, memberType, SignatureKind.Call) : emptySignatures;
}

function isArrayOrTupleSymbol(c: Checker, symbol: Symbol): boolean {
  if (c.globalArrayType.symbol === undefined || c.globalReadonlyArrayType.symbol === undefined) return false;
  return (
    sameReference(c, symbol, c.globalArrayType.symbol) || sameReference(c, symbol, c.globalReadonlyArrayType.symbol)
  );
}

function isReadonlyArraySymbol(c: Checker, symbol: Symbol): boolean {
  return c.globalReadonlyArrayType.symbol !== undefined && sameReference(c, symbol, c.globalReadonlyArrayType.symbol);
}

function sameReference(c: Checker, s1: Symbol, s2: Symbol): boolean {
  return getMergedSymbol(c, s1) === getMergedSymbol(c, s2);
}

/**
 * The signatures present in every constituent: generic ones must match exactly; others may have
 * extra optional parameters and differing return types, which are unioned.
 */
export function getUnionSignatures(c: Checker, signatureLists: Signature[][]): Signature[] {
  let result: Signature[] | undefined;
  let indexWithLengthOverOne = 0;
  let countLengthOverOne = 0;
  for (let i = 0; i < signatureLists.length; i++) {
    const list = signatureLists[i]!;
    if (list.length === 0) return emptySignatures;
    if (list.length > 1) {
      indexWithLengthOverOne = i;
      countLengthOverOne++;
    }
    for (const signature of list) {
      if (result !== undefined && findMatchingSignature(c, result, signature, false, false, true) !== undefined)
        continue;
      const unionSignatures = findMatchingSignatures(c, signatureLists, signature, i);
      if (unionSignatures === undefined) continue;
      let s = signature;
      if (unionSignatures.length > 1) {
        let thisParameter = signature.thisParameter;
        let firstThisParameter: Symbol | undefined;
        for (const sig of unionSignatures)
          if (sig.thisParameter !== undefined) {
            firstThisParameter = sig.thisParameter;
            break;
          }
        if (firstThisParameter !== undefined) {
          const thisTypes: Type[] = [];
          for (const sig of unionSignatures)
            if (sig.thisParameter !== undefined) thisTypes.push(getTypeOfSymbol(c, sig.thisParameter));
          thisParameter = createSymbolWithType(c, firstThisParameter, getIntersectionType(c, thisTypes));
        }
        s = createUnionSignature(c, signature, unionSignatures);
        s.thisParameter = thisParameter;
      }
      if (result === undefined) result = [];
      result.push(s);
    }
  }
  if ((result === undefined || result.length === 0) && countLengthOverOne <= 1) {
    // One constituent has overloads: try a single signature that handles all of them.
    const masterList = signatureLists[indexWithLengthOverOne]!;
    let results: Signature[] | undefined = masterList.slice();
    for (const signatures of signatureLists) {
      if (signatures === masterList) continue;
      const signature = signatures[0]!;
      if (signature.typeParameters.length !== 0 && hasNonIdenticalTypeParameters(c, results, signature)) {
        results = undefined;
        break;
      }
      const combined: Signature[] = [];
      for (const sig of results) combined.push(combineUnionOrIntersectionMemberSignatures(c, sig, signature, true));
      results = combined;
    }
    result = results;
  }
  return result ?? emptySignatures;
}

function findMatchingSignatures(
  c: Checker,
  signatureLists: Signature[][],
  signature: Signature,
  listIndex: number,
): Signature[] | undefined {
  if (signature.typeParameters.length !== 0) {
    // Generic signatures need exact matches in the other lists.
    if (listIndex > 0) return undefined;
    for (let i = 1; i < signatureLists.length; i++)
      if (findMatchingSignature(c, signatureLists[i]!, signature, false, false, false) === undefined) return undefined;
    return [signature];
  }
  const result: Signature[] = [];
  for (let i = 0; i < signatureLists.length; i++) {
    const match =
      i === listIndex
        ? signature
        : (findMatchingSignature(c, signatureLists[i]!, signature, false, false, true) ??
          findMatchingSignature(c, signatureLists[i]!, signature, true, false, true));
    if (match === undefined) return undefined;
    if (!result.includes(match)) result.push(match);
  }
  return result;
}

export function findMatchingSignature(
  c: Checker,
  signatureList: readonly Signature[],
  signature: Signature,
  partialMatch: boolean,
  ignoreThisTypes: boolean,
  ignoreReturnTypes: boolean,
): Signature | undefined {
  for (const s of signatureList)
    if (
      compareSignaturesIdentical(
        c,
        s,
        signature,
        partialMatch,
        ignoreThisTypes,
        ignoreReturnTypes,
        partialMatch ? ComparerKind.SubtypeOf : ComparerKind.Identical,
      ) !== Ternary.False
    )
      return s;
  return undefined;
}

function hasNonIdenticalTypeParameters(c: Checker, signatures: readonly Signature[], signature: Signature): boolean {
  for (const s of signatures)
    if (s.typeParameters.length !== 0 && !compareTypeParametersIdentical(c, signature.typeParameters, s.typeParameters))
      return true;
  return false;
}

export function compareTypeParametersIdentical(c: Checker, sourceParams: Type[], targetParams: Type[]): boolean {
  if (sourceParams.length !== targetParams.length) return false;
  const mapper = newTypeMapper(targetParams, sourceParams);
  for (let i = 0; i < sourceParams.length; i++) {
    const source = sourceParams[i]!;
    const target = targetParams[i]!;
    if (source === target) continue;
    // A type parameter matches another one with an identical (instantiated) constraint.
    const sourceConstraint = getConstraintFromTypeParameter(c, source) ?? c.unknownType;
    const targetConstraint = getConstraintFromTypeParameter(c, target);
    if (
      !compareTypesIdenticalBool(
        c,
        sourceConstraint,
        targetConstraint !== undefined ? instantiateType(c, targetConstraint, mapper) : c.unknownType,
      )
    )
      return false;
  }
  return true;
}

function compareTypesIdenticalBool(c: Checker, s: Type, t: Type): boolean {
  return compareTypesIdentical(c, s, t) !== Ternary.False;
}

function createUnionSignature(c: Checker, sig: Signature, unionSignatures: Signature[]): Signature {
  const result = cloneSignature(c, sig);
  result.composite = new CompositeSignature(true, unionSignatures);
  result.target = undefined;
  result.mapper = undefined;
  return result;
}

export function combineUnionOrIntersectionMemberSignatures(
  c: Checker,
  left: Signature,
  right: Signature,
  isUnion: boolean,
): Signature {
  const typeParams = left.typeParameters.length !== 0 ? left.typeParameters : right.typeParameters;
  // Use the type parameter defaults from the first signature.
  const paramMapper =
    left.typeParameters.length !== 0 && right.typeParameters.length !== 0
      ? newTypeMapper(right.typeParameters, left.typeParameters)
      : undefined;
  let flags = (left.flags | right.flags) & (SignatureFlags.PropagatingFlags & ~SignatureFlags.HasRestParameter);
  const params = combineUnionOrIntersectionParameters(c, left, right, paramMapper, isUnion);
  const lastParam = params.length !== 0 ? params[params.length - 1]! : undefined;
  if (lastParam !== undefined && (lastParam.checkFlags & CheckFlags.RestParameter) !== 0)
    flags |= SignatureFlags.HasRestParameter;
  const thisParam = combineUnionOrIntersectionThisParam(
    c,
    left.thisParameter,
    right.thisParameter,
    paramMapper,
    isUnion,
  );
  const minArgCount = Math.max(left.minArgumentCount, right.minArgumentCount);
  const result = c.newSignature(flags, left.declaration, typeParams, thisParam, params, undefined, minArgCount);
  const leftSignatures = left.composite !== undefined && left.composite.isUnion ? left.composite.signatures : [left];
  result.composite = new CompositeSignature(isUnion, leftSignatures.concat([right]));
  if (paramMapper !== undefined) {
    result.mapper =
      left.composite !== undefined && left.composite.isUnion === isUnion && left.mapper !== undefined
        ? combineMappers(c, left.mapper, paramMapper)
        : paramMapper;
  } else if (left.composite !== undefined && left.composite.isUnion === isUnion) result.mapper = left.mapper;
  return result;
}

import { combineTypeMappers as combineMappers } from './instantiation.js';

function combineUnionOrIntersectionParameters(
  c: Checker,
  left: Signature,
  right: Signature,
  mapper: TypeMapper | undefined,
  isUnion: boolean,
): Symbol[] {
  const leftCount = getParameterCount(c, left);
  const rightCount = getParameterCount(c, right);
  const longest = leftCount >= rightCount ? left : right;
  const shorter = longest === left ? right : left;
  const longestCount = longest === left ? leftCount : rightCount;
  const eitherHasEffectiveRest = hasEffectiveRestParameter(c, left) || hasEffectiveRestParameter(c, right);
  const needsExtraRestElement = eitherHasEffectiveRest && !hasEffectiveRestParameter(c, longest);
  const params: Symbol[] = [];
  for (let i = 0; i < longestCount; i++) {
    let longestParamType = tryGetTypeAtPosition(c, longest, i)!;
    if (longest === right) longestParamType = instantiateType(c, longestParamType, mapper);
    let shorterParamType = tryGetTypeAtPosition(c, shorter, i) ?? c.unknownType;
    if (shorter === right) shorterParamType = instantiateType(c, shorterParamType, mapper);
    const combinedParamType = getUnionOrIntersectionType(
      c,
      [longestParamType, shorterParamType],
      !isUnion,
      UnionReduction.Literal,
    );
    const isRestParam = eitherHasEffectiveRest && !needsExtraRestElement && i === longestCount - 1;
    const isOptional = i >= getMinArgumentCount(c, longest) && i >= getMinArgumentCount(c, shorter);
    const leftName = i < leftCount ? getParameterNameAtPosition(c, left, i) : '';
    const rightName = i < rightCount ? getParameterNameAtPosition(c, right, i) : '';
    let paramName = leftName === rightName ? leftName : leftName === '' ? rightName : rightName === '' ? leftName : '';
    if (paramName === '') paramName = 'arg' + i;
    const paramSymbol = c.newSymbolWithCheckFlags(
      SymbolFlags.FunctionScopedVariable | (isOptional && !isRestParam ? SymbolFlags.Optional : 0),
      paramName,
      isRestParam ? CheckFlags.RestParameter : isOptional ? CheckFlags.OptionalParameter : CheckFlags.None,
    );
    c.symbolLinks(paramSymbol).type = isRestParam ? createArrayTypeEx(c, combinedParamType, false) : combinedParamType;
    params.push(paramSymbol);
  }
  if (needsExtraRestElement) {
    const restParamSymbol = c.newSymbolWithCheckFlags(
      SymbolFlags.FunctionScopedVariable,
      'args',
      CheckFlags.RestParameter,
    );
    let restType = createArrayTypeEx(c, getTypeAtPosition(c, shorter, longestCount), false);
    if (shorter === right) restType = instantiateType(c, restType, mapper);
    c.symbolLinks(restParamSymbol).type = restType;
    params.push(restParamSymbol);
  }
  return params;
}

function combineUnionOrIntersectionThisParam(
  c: Checker,
  left: Symbol | undefined,
  right: Symbol | undefined,
  mapper: TypeMapper | undefined,
  isUnion: boolean,
): Symbol | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  // Intersected like parameter types, to be permissive when calling.
  const thisType = getUnionOrIntersectionType(
    c,
    [getTypeOfSymbol(c, left), instantiateType(c, getTypeOfSymbol(c, right), mapper)],
    !isUnion,
    UnionReduction.Literal,
  );
  return createSymbolWithType(c, left, thisType);
}

export function getUnionIndexInfos(c: Checker, types: readonly Type[]): IndexInfo[] {
  const sourceInfos = getIndexInfosOfType(c, types[0]!);
  const result: IndexInfo[] = [];
  for (const info of sourceInfos) {
    const indexType = info.keyType;
    let everyHas = true;
    for (const t of types)
      if (getIndexInfoOfType(c, t, indexType) === undefined) {
        everyHas = false;
        break;
      }
    if (!everyHas) continue;
    const valueTypes: Type[] = [];
    let isReadonly = false;
    for (const t of types) {
      const i = getIndexInfoOfType(c, t, indexType)!;
      valueTypes.push(i.valueType);
      if (i.isReadonly) isReadonly = true;
    }
    result.push(new IndexInfo(indexType, getUnionType(c, valueTypes), isReadonly, undefined, []));
  }
  return result;
}

function resolveIntersectionTypeMembers(c: Checker, t: IntersectionType): void {
  let callSignatures: Signature[] = [];
  let constructSignatures: Signature[] = [];
  let indexInfos: IndexInfo[] = [];
  const types = t.types;
  const mixinFlags: boolean[] = [];
  for (const u of types) mixinFlags.push(isMixinConstructorType(c, u));
  let constructorTypeCount = 0;
  let mixinCount = 0;
  let firstMixinIndex = -1;
  for (let i = 0; i < types.length; i++) {
    if (getSignaturesOfType(c, types[i]!, SignatureKind.Construct).length > 0) constructorTypeCount++;
    if (mixinFlags[i]!) {
      if (firstMixinIndex < 0) firstMixinIndex = i;
      mixinCount++;
    }
  }
  if (constructorTypeCount > 0 && constructorTypeCount === mixinCount) {
    mixinFlags[firstMixinIndex] = false;
    mixinCount--;
  }
  for (let i = 0; i < types.length; i++) {
    const u = types[i]!;
    // Mixin construct signatures are dropped; their return types mix into the others.
    if (!mixinFlags[i]!) {
      let signatures = getSignaturesOfType(c, u, SignatureKind.Construct);
      if (signatures.length !== 0 && mixinCount > 0) {
        const clones: Signature[] = [];
        for (const s of signatures) {
          const clone = cloneSignature(c, s);
          clone.resolvedReturnType = includeMixinType(c, getReturnTypeOfSignature(c, s), types, mixinFlags, i);
          clones.push(clone);
        }
        signatures = clones;
      }
      constructSignatures = appendSignatures(c, constructSignatures, signatures);
    }
    callSignatures = appendSignatures(c, callSignatures, getSignaturesOfType(c, u, SignatureKind.Call));
    for (const info of getIndexInfosOfType(c, u)) indexInfos = appendIndexInfo(c, indexInfos, info, false);
  }
  setStructuredTypeMembers(c, t, undefined, callSignatures, constructSignatures, indexInfos);
}

function includeMixinType(c: Checker, t: Type, types: readonly Type[], mixinFlags: boolean[], index: number): Type {
  const mixed: Type[] = [];
  for (let i = 0; i < types.length; i++) {
    if (i === index) mixed.push(t);
    else if (mixinFlags[i]!)
      mixed.push(getReturnTypeOfSignature(c, getSignaturesOfType(c, types[i]!, SignatureKind.Construct)[0]!));
  }
  return getIntersectionType(c, mixed);
}

function appendSignatures(c: Checker, signatures: Signature[], newSignatures: readonly Signature[]): Signature[] {
  for (const sig of newSignatures) {
    let unique = true;
    for (const s of signatures)
      if (compareSignaturesIdentical(c, s, sig, false, false, false, ComparerKind.Identical) !== Ternary.False) {
        unique = false;
        break;
      }
    if (signatures.length === 0 || unique) signatures.push(sig);
  }
  return signatures;
}

export function appendIndexInfo(c: Checker, indexInfos: IndexInfo[], newInfo: IndexInfo, union: boolean): IndexInfo[] {
  for (let i = 0; i < indexInfos.length; i++) {
    const info = indexInfos[i]!;
    if (info.keyType !== newInfo.keyType) continue;
    const valueType = union
      ? getUnionType(c, [info.valueType, newInfo.valueType])
      : getIntersectionType(c, [info.valueType, newInfo.valueType]);
    const isReadonly = union ? info.isReadonly || newInfo.isReadonly : info.isReadonly && newInfo.isReadonly;
    indexInfos[i] = new IndexInfo(info.keyType, valueType, isReadonly, undefined, []);
    return indexInfos;
  }
  indexInfos.push(newInfo);
  return indexInfos;
}

// ---- Properties

export function getPropertiesOfType(c: Checker, t: Type): Symbol[] {
  t = getReducedApparentType(c, t);
  if ((t.flags & TypeFlags.UnionOrIntersection) !== 0)
    return getPropertiesOfUnionOrIntersectionType(c, t as UnionOrIntersectionType);
  return getPropertiesOfObjectType(c, t);
}

export function getPropertiesOfObjectType(c: Checker, t: Type): Symbol[] {
  return (t.flags & TypeFlags.Object) !== 0 ? resolveStructuredTypeMembers(c, t).properties : emptySymbols;
}

export function getPropertiesOfUnionOrIntersectionType(c: Checker, t: UnionOrIntersectionType): Symbol[] {
  if (t.resolvedProperties === undefined) {
    const checked = new Set<string>();
    const props: Symbol[] = [];
    for (const current of t.types) {
      // Only the names are read here (the properties come from the lookups by name).
      const sources = getPropertySourcesOfType(c, current);
      for (let i = 0; i < sources.length; i++) {
        const name = sources[i]!.name;
        if (checked.has(name)) continue;
        checked.add(name);
        const combined = getPropertyOfUnionOrIntersectionType(c, t, name, (t.flags & TypeFlags.Intersection) !== 0);
        if (combined !== undefined) props.push(combined);
      }
      // Union properties are in every constituent: the first without index signatures suffices.
      if ((t.flags & TypeFlags.Union) !== 0 && getIndexInfosOfType(c, current).length === 0) break;
    }
    t.resolvedProperties = props;
  }
  return t.resolvedProperties;
}

export function getPropertyOfType(c: Checker, t: Type, name: string): Symbol | undefined {
  return getPropertyOfTypeEx(c, t, name, false, false);
}

/**
 * The property `name` of `t`: synthesizes union and intersection properties, uses apparent types of
 * primitives and type parameters, and falls back to Object and Function members.
 */
export function getPropertyOfTypeEx(
  c: Checker,
  t: Type,
  name: string,
  skipObjectFunctionPropertyAugment: boolean,
  includeTypeOnlyMembers: boolean,
): Symbol | undefined {
  t = getReducedApparentType(c, t);
  if ((t.flags & TypeFlags.Object) !== 0) {
    const resolved = resolveStructuredTypeMembers(c, t);
    const symbol = getResolvedMember(resolved, name);
    if (symbol !== undefined && (includeTypeOnlyMembers || symbolIsValue(c, symbol))) return symbol;
    if (symbol !== undefined && includeTypeOnlyMembers) return symbol;
    if (skipObjectFunctionPropertyAugment) return undefined;
    let functionType: Type | undefined;
    if (t === c.anyFunctionType) functionType = c.globalFunctionType;
    else if (resolved.callSignatures.length !== 0) functionType = c.globalCallableFunctionType;
    else if (resolved.constructSignatures.length !== 0) functionType = c.globalNewableFunctionType;
    if (functionType !== undefined) {
      const found = getPropertyOfObjectType(c, functionType, name);
      if (found !== undefined) return found;
    }
    return getPropertyOfObjectType(c, c.globalObjectType, name);
  }
  if ((t.flags & TypeFlags.Intersection) !== 0) {
    const prop = getPropertyOfUnionOrIntersectionType(c, t as UnionOrIntersectionType, name, true);
    if (prop !== undefined) return prop;
    if (!skipObjectFunctionPropertyAugment)
      return getPropertyOfUnionOrIntersectionType(c, t as UnionOrIntersectionType, name, false);
    return undefined;
  }
  if ((t.flags & TypeFlags.Union) !== 0)
    return getPropertyOfUnionOrIntersectionType(
      c,
      t as UnionOrIntersectionType,
      name,
      skipObjectFunctionPropertyAugment,
    );
  return undefined;
}

export function getPropertyOfObjectType(c: Checker, t: Type, name: string): Symbol | undefined {
  if ((t.flags & TypeFlags.Object) === 0) return undefined;
  const symbol = getResolvedMember(resolveStructuredTypeMembers(c, t), name);
  return symbol !== undefined && symbolIsValue(c, symbol) ? symbol : undefined;
}

export function getTypeOfPropertyOfType(c: Checker, t: Type, name: string): Type | undefined {
  const prop = getPropertyOfType(c, t, name);
  return prop !== undefined ? getTypeOfSymbol(c, prop) : undefined;
}

export function getPropertyOfUnionOrIntersectionType(
  c: Checker,
  t: UnionOrIntersectionType,
  name: string,
  skipObjectFunctionPropertyAugment: boolean,
): Symbol | undefined {
  const prop = getUnionOrIntersectionProperty(c, t, name, skipObjectFunctionPropertyAugment);
  // Partial union properties are filtered out.
  return prop !== undefined && (prop.checkFlags & CheckFlags.ReadPartial) !== 0 ? undefined : prop;
}

/** The (possibly partial) property `name` of a union or intersection, cached on the type. */
export function getUnionOrIntersectionProperty(
  c: Checker,
  t: UnionOrIntersectionType,
  name: string,
  skipObjectFunctionPropertyAugment: boolean,
): Symbol | undefined {
  let cache = skipObjectFunctionPropertyAugment ? t.propertyCacheWithoutFunctionPropertyAugment : t.propertyCache;
  const cached = cache?.get(name);
  if (cached !== undefined) return cached;
  const prop = createUnionOrIntersectionProperty(c, t, name, skipObjectFunctionPropertyAugment);
  if (prop !== undefined) {
    if (cache === undefined) {
      cache = new Map<string, Symbol>();
      if (skipObjectFunctionPropertyAugment) t.propertyCacheWithoutFunctionPropertyAugment = cache;
      else t.propertyCache = cache;
    }
    cache.set(name, prop);
    // Non-partial results also serve the augmented cache.
    if (skipObjectFunctionPropertyAugment && (prop.checkFlags & CheckFlags.Partial) === 0) {
      let augmented = t.propertyCache;
      if (augmented === undefined) {
        augmented = new Map<string, Symbol>();
        t.propertyCache = augmented;
      }
      if (!augmented.has(name)) augmented.set(name, prop);
    }
  }
  return prop;
}

export function getDeclarationModifierFlagsFromSymbol(c: Checker, s: Symbol, isWrite: boolean): ModifierFlags {
  if (s.valueDeclaration !== undefined) {
    let declaration: Node | undefined;
    if (isWrite) declaration = getDeclarationOfKind(s, SyntaxKind.SetAccessor);
    if (declaration === undefined && (s.flags & SymbolFlags.GetAccessor) !== 0)
      declaration = getDeclarationOfKind(s, SyntaxKind.GetAccessor);
    if (declaration === undefined) declaration = s.valueDeclaration;
    const flags = getCombinedModifierFlags(declaration);
    return s.parent !== undefined && (s.parent.flags & SymbolFlags.Class) !== 0
      ? flags
      : flags & ~ModifierFlags.AccessibilityModifier;
  }
  if ((s.checkFlags & CheckFlags.Synthetic) !== 0) {
    const access =
      (s.checkFlags & CheckFlags.ContainsPrivate) !== 0
        ? ModifierFlags.Private
        : (s.checkFlags & CheckFlags.ContainsPublic) !== 0
          ? ModifierFlags.Public
          : ModifierFlags.Protected;
    const staticModifier = (s.checkFlags & CheckFlags.ContainsStatic) !== 0 ? ModifierFlags.Static : 0;
    return access | staticModifier;
  }
  if ((s.flags & SymbolFlags.Prototype) !== 0) return ModifierFlags.Public | ModifierFlags.Static;
  return 0;
}

export function createUnionOrIntersectionProperty(
  c: Checker,
  containingType: UnionOrIntersectionType,
  name: string,
  skipObjectFunctionPropertyAugment: boolean,
): Symbol | undefined {
  let propFlags = SymbolFlags.None;
  let singleProp: Symbol | undefined;
  let propSet: Symbol[] | undefined;
  const indexTypes: Type[] = [];
  const isUnion = (containingType.flags & TypeFlags.Union) !== 0;
  // Flags propagated when present in every constituent.
  let checkFlags = isUnion ? CheckFlags.None : CheckFlags.Readonly;
  let optionalFlag = isUnion ? SymbolFlags.None : SymbolFlags.Optional;
  let syntheticFlag = CheckFlags.SyntheticMethod;
  let mergedInstantiations = false;
  for (const current of containingType.types) {
    const t = getApparentType(c, current);
    if (isErrorType(c, t) || (t.flags & TypeFlags.Never) !== 0) continue;
    const prop = getPropertyOfTypeEx(c, t, name, skipObjectFunctionPropertyAugment, false);
    if (prop !== undefined) {
      const modifiers = getDeclarationModifierFlagsFromSymbol(c, prop, false);
      if ((prop.flags & SymbolFlags.ClassMember) !== 0) {
        if (isUnion) optionalFlag |= prop.flags & SymbolFlags.Optional;
        else optionalFlag &= prop.flags;
      }
      if (singleProp === undefined) {
        singleProp = prop;
        propFlags = prop.flags & SymbolFlags.Accessor || SymbolFlags.Property;
      } else if (prop !== singleProp) {
        const isInstantiation = getTargetSymbol(c, prop) === getTargetSymbol(c, singleProp);
        // Instantiations with identical types are equivalent; keep the first.
        if (isInstantiation && compareProperties(c, singleProp, prop, ComparerKind.Equal) === Ternary.True) {
          mergedInstantiations =
            singleProp.parent !== undefined &&
            getLocalTypeParametersOfClassOrInterfaceOrTypeAlias(c, singleProp.parent).length !== 0;
        } else {
          if (propSet === undefined) propSet = [singleProp];
          if (!propSet.includes(prop)) propSet.push(prop);
        }
        // Accessor flags survive only when the same in all constituents.
        if (
          (propFlags & SymbolFlags.Accessor) !== 0 &&
          (prop.flags & SymbolFlags.Accessor) !== (propFlags & SymbolFlags.Accessor)
        )
          propFlags = (propFlags & ~SymbolFlags.Accessor) | SymbolFlags.Property;
      }
      if (isUnion && isReadonlySymbol(c, prop)) checkFlags |= CheckFlags.Readonly;
      else if (!isUnion && !isReadonlySymbol(c, prop)) checkFlags &= ~CheckFlags.Readonly;
      if ((modifiers & ModifierFlags.NonPublicAccessibilityModifier) === 0) checkFlags |= CheckFlags.ContainsPublic;
      if ((modifiers & ModifierFlags.Protected) !== 0) checkFlags |= CheckFlags.ContainsProtected;
      if ((modifiers & ModifierFlags.Private) !== 0) checkFlags |= CheckFlags.ContainsPrivate;
      if ((modifiers & ModifierFlags.Static) !== 0) checkFlags |= CheckFlags.ContainsStatic;
      if (!isPrototypeProperty(prop)) syntheticFlag = CheckFlags.SyntheticProperty;
    } else if (isUnion) {
      const indexInfo = !isLateBoundName(name) ? getApplicableIndexInfoForName(c, t, name) : undefined;
      if (indexInfo !== undefined) {
        propFlags = (propFlags & ~SymbolFlags.Accessor) | SymbolFlags.Property;
        checkFlags |= CheckFlags.WritePartial | (indexInfo.isReadonly ? CheckFlags.Readonly : 0);
        indexTypes.push(isTupleType(t) ? (getRestTypeOfTupleType(c, t) ?? c.undefinedType) : indexInfo.valueType);
      } else if (isObjectLiteralType(t) && (t.objectFlags & ObjectFlags.ContainsSpread) === 0) {
        checkFlags |= CheckFlags.WritePartial;
        indexTypes.push(c.undefinedType);
      } else checkFlags |= CheckFlags.ReadPartial;
    }
  }
  if (
    singleProp === undefined ||
    (isUnion &&
      (propSet !== undefined || (checkFlags & CheckFlags.Partial) !== 0) &&
      (checkFlags & (CheckFlags.ContainsPrivate | CheckFlags.ContainsProtected)) !== 0 &&
      !(propSet !== undefined && hasCommonDeclaration(propSet)))
  )
    // Missing, or private/protected in one constituent but missing or different in another.
    return undefined;
  if (propSet === undefined && (checkFlags & CheckFlags.ReadPartial) === 0 && indexTypes.length === 0) {
    if (!mergedInstantiations) return singleProp;
    // Merged instantiations get a clone without a union parent, so `Array<T>.length` prints as such.
    let singlePropType: Type | undefined;
    let singlePropMapper: TypeMapper | undefined;
    if ((singleProp.flags & SymbolFlags.Transient) !== 0) {
      const links = c.symbolLinks(singleProp);
      singlePropType = links.type;
      singlePropMapper = links.mapper;
    }
    const clone = createSymbolWithType(c, singleProp, singlePropType);
    if (singleProp.valueDeclaration !== undefined) clone.parent = getSymbol(singleProp.valueDeclaration)?.parent;
    const links = c.symbolLinks(clone);
    links.containingType = containingType;
    links.mapper = singlePropMapper;
    links.writeType = getWriteTypeOfSymbol(c, singleProp);
    return clone;
  }
  const props = propSet ?? [singleProp];
  const declarations: Node[] = [];
  let firstType: Type | undefined;
  let nameType: Type | undefined;
  const propTypes: Type[] = [];
  let writeTypes: Type[] | undefined;
  let firstValueDeclaration: Node | undefined;
  let hasNonUniformValueDeclaration = false;
  for (const prop of props) {
    if (firstValueDeclaration === undefined) firstValueDeclaration = prop.valueDeclaration;
    else if (prop.valueDeclaration !== undefined && prop.valueDeclaration !== firstValueDeclaration)
      hasNonUniformValueDeclaration = true;
    for (const d of prop.declarations) declarations.push(d);
    const t = getTypeOfSymbol(c, prop);
    if (firstType === undefined) {
      firstType = t;
      nameType = c.symbolLinks(prop).nameType;
    }
    const writeType = getWriteTypeOfSymbol(c, prop);
    if (writeTypes !== undefined || writeType !== t) {
      if (writeTypes === undefined) writeTypes = propTypes.slice();
      writeTypes.push(writeType);
    }
    if (t !== firstType) checkFlags |= CheckFlags.HasNonUniformType;
    if (isLiteralType(t) || isPatternLiteralType(c, t)) checkFlags |= CheckFlags.HasLiteralType;
    if ((t.flags & TypeFlags.Never) !== 0 && t !== c.uniqueLiteralType) checkFlags |= CheckFlags.HasNeverType;
    propTypes.push(t);
  }
  for (const t of indexTypes) propTypes.push(t);
  const result = c.newSymbolWithCheckFlags(propFlags | optionalFlag, name, checkFlags | syntheticFlag);
  result.declarations = declarations;
  if (!hasNonUniformValueDeclaration && firstValueDeclaration !== undefined) {
    result.valueDeclaration = firstValueDeclaration;
    result.parent = getSymbol(firstValueDeclaration)?.parent;
  }
  const links = c.symbolLinks(result);
  links.containingType = containingType;
  links.nameType = nameType;
  if (propTypes.length > 2) {
    // Defer normalization of possibly large constituent lists.
    result.checkFlags |= CheckFlags.DeferredType;
    links.deferralParent = containingType;
    links.deferralConstituents = propTypes;
    links.deferralWriteConstituents = writeTypes;
    return result;
  }
  links.type = isUnion ? getUnionType(c, propTypes) : getIntersectionType(c, propTypes);
  if (writeTypes !== undefined)
    links.writeType = isUnion ? getUnionType(c, writeTypes) : getIntersectionType(c, writeTypes);
  return result;
}

export function isObjectLiteralType(t: Type): boolean {
  return (t.objectFlags & ObjectFlags.ObjectLiteral) !== 0;
}

export function getTargetSymbol(c: Checker, s: Symbol): Symbol {
  return (s.checkFlags & CheckFlags.Instantiated) !== 0 ? c.symbolLinks(s).target! : s;
}

export function isPrototypeProperty(symbol: Symbol): boolean {
  return (symbol.flags & SymbolFlags.Method) !== 0 || (symbol.checkFlags & CheckFlags.SyntheticMethod) !== 0;
}

function hasCommonDeclaration(symbols: Symbol[]): boolean {
  let common: Set<Node> | undefined;
  for (const symbol of symbols) {
    if (symbol.declarations.length === 0) return false;
    if (common === undefined) {
      common = new Set(symbol.declarations);
      continue;
    }
    const next = new Set<Node>();
    for (const d of symbol.declarations) if (common.has(d)) next.add(d);
    if (next.size === 0) return false;
    common = next;
  }
  return common !== undefined && common.size !== 0;
}

export function createSymbolWithType(c: Checker, source: Symbol, t: Type | undefined): Symbol {
  const symbol = c.newSymbolWithCheckFlags(source.flags, source.name, source.checkFlags & CheckFlags.Readonly);
  symbol.declarations = source.declarations;
  symbol.parent = source.parent;
  symbol.valueDeclaration = source.valueDeclaration;
  const links = c.symbolLinks(symbol);
  links.type = t;
  links.target = source;
  links.nameType = c.symbolLinks(source).nameType;
  return symbol;
}

// ---- Signatures and index infos

export function getSignaturesOfType(c: Checker, t: Type, kind: SignatureKind): Signature[] {
  return getSignaturesOfStructuredType(c, getReducedApparentType(c, t), kind);
}

export function getSignaturesOfStructuredType(c: Checker, t: Type, kind: SignatureKind): Signature[] {
  if ((t.flags & TypeFlags.StructuredType) === 0) return emptySignatures;
  const resolved = resolveStructuredTypeMembers(c, t);
  return kind === SignatureKind.Call ? resolved.callSignatures : resolved.constructSignatures;
}

export function getIndexInfosOfType(c: Checker, t: Type): IndexInfo[] {
  return getIndexInfosOfStructuredType(c, getReducedApparentType(c, t));
}

export function getIndexInfosOfStructuredType(c: Checker, t: Type): IndexInfo[] {
  return (t.flags & TypeFlags.StructuredType) !== 0 ? resolveStructuredTypeMembers(c, t).indexInfos : emptyIndexInfos;
}

export function getIndexInfoOfType(c: Checker, t: Type, keyType: Type): IndexInfo | undefined {
  return findIndexInfo(getIndexInfosOfType(c, t), keyType);
}

export function getIndexTypeOfType(c: Checker, t: Type, keyType: Type): Type | undefined {
  const info = getIndexInfoOfType(c, t, keyType);
  return info !== undefined ? info.valueType : undefined;
}

export function getApplicableIndexInfo(c: Checker, t: Type, keyType: Type): IndexInfo | undefined {
  return findApplicableIndexInfo(c, getIndexInfosOfType(c, t), keyType);
}

export function getApplicableIndexInfoForName(c: Checker, t: Type, name: string): IndexInfo | undefined {
  return getApplicableIndexInfo(c, t, isLateBoundName(name) ? c.esSymbolType : getStringLiteralType(c, name));
}

export function findApplicableIndexInfo(
  c: Checker,
  indexInfos: readonly IndexInfo[],
  keyType: Type,
): IndexInfo | undefined {
  // `string` index signatures apply only when no other one does.
  let stringIndexInfo: IndexInfo | undefined;
  const applicable: IndexInfo[] = [];
  for (const info of indexInfos) {
    if (info.keyType === c.stringType) stringIndexInfo = info;
    else if (isApplicableIndexType(c, keyType, info.keyType)) applicable.push(info);
  }
  if (applicable.length === 0)
    return stringIndexInfo !== undefined && isApplicableIndexType(c, keyType, c.stringType)
      ? stringIndexInfo
      : undefined;
  if (applicable.length === 1) return applicable[0]!;
  // Several apply: a synthetic info; its key type is unused.
  let isReadonly = true;
  const types: Type[] = [];
  for (const info of applicable) {
    types.push(info.valueType);
    if (!info.isReadonly) isReadonly = false;
  }
  return new IndexInfo(c.unknownType, getIntersectionType(c, types), isReadonly, undefined, []);
}

export function isApplicableIndexType(c: Checker, source: Type, target: Type): boolean {
  // `string` applies to keys assignable to string or number; `number` to numeric strings too.
  return (
    isTypeAssignableTo(c, source, target) ||
    (target === c.stringType && isTypeAssignableTo(c, source, c.numberType)) ||
    (target === c.numberType &&
      (source === c.numericStringType ||
        ((source.flags & TypeFlags.StringLiteral) !== 0 && isNumericLiteralName((source as LiteralType).stringValue))))
  );
}

export function isArrayLikeType(c: Checker, t: Type): boolean {
  // Readonly arrays are array-like: anything assignable to `readonly any[]`.
  return (
    isArrayType(c, t) || ((t.flags & TypeFlags.Nullable) === 0 && isTypeAssignableTo(c, t, c.anyReadonlyArrayType))
  );
}

function isArrayType(c: Checker, t: Type): boolean {
  if ((t.objectFlags & ObjectFlags.Reference) === 0) return false;
  const target = (t as TypeReference).target;
  return target === c.globalArrayType || target === c.globalReadonlyArrayType;
}

// ---- Apparent and reduced types

/** Type parameters' base constraints; primitives' wrapper object types; otherwise the type itself. */
export function getApparentType(c: Checker, t: Type): Type {
  const originalType = t;
  if ((t.flags & TypeFlags.Instantiable) !== 0) t = getBaseConstraintOfType(c, t) ?? c.unknownType;
  const flags = t.flags;
  if ((t.objectFlags & ObjectFlags.Mapped) !== 0 && (flags & TypeFlags.Object) !== 0)
    return getApparentTypeOfMappedType(c, t as MappedType);
  if ((t.objectFlags & ObjectFlags.Reference) !== 0 && (flags & TypeFlags.Object) !== 0 && t !== originalType)
    return getTypeWithThisArgument(c, t, originalType, false);
  if ((flags & TypeFlags.Intersection) !== 0)
    return getApparentTypeOfIntersectionType(c, t as IntersectionType, originalType);
  if ((flags & TypeFlags.StringLike) !== 0) return c.globalStringType;
  if ((flags & TypeFlags.NumberLike) !== 0) return c.globalNumberType;
  if ((flags & TypeFlags.BigIntLike) !== 0) return getGlobalBigIntType(c);
  if ((flags & TypeFlags.BooleanLike) !== 0) return c.globalBooleanType;
  if ((flags & TypeFlags.ESSymbolLike) !== 0) return getGlobalESSymbolType(c);
  if ((flags & TypeFlags.NonPrimitive) !== 0) return c.emptyObjectType;
  if ((flags & TypeFlags.Index) !== 0) return c.stringNumberSymbolType;
  if ((flags & TypeFlags.Unknown) !== 0 && !c.strictNullChecks) return c.emptyObjectType;
  return t;
}

function getApparentTypeOfMappedType(c: Checker, t: MappedType): Type {
  if (t.resolvedApparentType === undefined) t.resolvedApparentType = getResolvedApparentTypeOfMappedType(c, t);
  return t.resolvedApparentType;
}

function getResolvedApparentTypeOfMappedType(c: Checker, t: MappedType): Type {
  const target = mappedTypeTarget(t);
  const typeVariable = getHomomorphicTypeVariable(c, target);
  if (typeVariable !== undefined && (target.declaration as MappedTypeNode).nameType === undefined) {
    // A homomorphic mapped type over an array or tuple constraint maps the constraint.
    const modifiersType = getModifiersTypeFromMappedType(c, t);
    const baseConstraint = isGenericMappedType(c, modifiersType)
      ? getApparentTypeOfMappedType(c, modifiersType as MappedType)
      : getBaseConstraintOfType(c, modifiersType);
    if (
      baseConstraint !== undefined &&
      everyType(baseConstraint, (u) => isArrayOrTupleType(c, u) || isArrayOrTupleOrIntersection(c, u))
    )
      return instantiateType(c, target, prependTypeMapping(typeVariable, baseConstraint, t.mapper));
  }
  return t;
}

export function isArrayOrTupleOrIntersection(c: Checker, t: Type): boolean {
  if ((t.flags & TypeFlags.Intersection) === 0) return false;
  for (const u of typesOf(t)) if (!isArrayOrTupleType(c, u)) return false;
  return true;
}

function getApparentTypeOfIntersectionType(c: Checker, t: IntersectionType, thisArgument: Type): Type {
  if (t.id === thisArgument.id) {
    if (t.resolvedApparentType === undefined)
      t.resolvedApparentType = getTypeWithThisArgument(c, t, thisArgument, true);
    return t.resolvedApparentType;
  }
  const key = cachedTypeKey(CachedTypeKind.Apparent, thisArgument.id);
  let result = c.cachedTypesById.get(key);
  if (result === undefined) {
    result = getTypeWithThisArgument(c, t, thisArgument, true);
    c.cachedTypesById.set(key, result);
  }
  return result;
}

export function getTypeWithThisArgument(
  c: Checker,
  t: Type,
  thisArgument: Type | undefined,
  needApparentType: boolean,
): Type {
  if ((t.objectFlags & ObjectFlags.Reference) !== 0 && (t.flags & TypeFlags.Object) !== 0) {
    const target = (t as TypeReference).target as InterfaceType;
    const typeArguments = getTypeArguments(c, t);
    if (target.typeParameters().length === typeArguments.length)
      return createTypeReference(c, target, typeArguments.concat([thisArgument ?? target.thisType!]));
    return t;
  }
  if ((t.flags & TypeFlags.Intersection) !== 0) {
    const types = typesOf(t);
    let changed = false;
    const newTypes: Type[] = [];
    for (const u of types) {
      const n = getTypeWithThisArgument(c, u, thisArgument, needApparentType);
      if (n !== u) changed = true;
      newTypes.push(n);
    }
    return changed ? getIntersectionType(c, newTypes) : t;
  }
  return needApparentType ? getApparentType(c, t) : t;
}

/**
 * Unions with reducible intersections are reduced; intersections with mutually exclusive
 * discriminants are `never`.
 */
export function getReducedType(c: Checker, t: Type): Type {
  if ((t.flags & TypeFlags.Union) !== 0) {
    if ((t.objectFlags & ObjectFlags.ContainsIntersections) !== 0) {
      const union = t as UnionType;
      if (union.resolvedReducedType !== undefined) return union.resolvedReducedType;
      const reduced = getReducedUnionType(c, union);
      union.resolvedReducedType = reduced;
      return reduced;
    }
  } else if ((t.flags & TypeFlags.Intersection) !== 0) {
    if ((t.objectFlags & ObjectFlags.IsNeverIntersectionComputed) === 0) {
      t.objectFlags |= ObjectFlags.IsNeverIntersectionComputed;
      if (isNeverReducedIntersection(c, t as IntersectionType)) t.objectFlags |= ObjectFlags.IsNeverIntersection;
    }
    if ((t.objectFlags & ObjectFlags.IsNeverIntersection) !== 0) return c.neverType;
  }
  return t;
}

function getReducedUnionType(c: Checker, union: UnionType): Type {
  let changed = false;
  const reducedTypes: Type[] = [];
  for (const u of union.types) {
    const r = getReducedType(c, u);
    if (r !== u) changed = true;
    reducedTypes.push(r);
  }
  if (!changed) return union;
  const reduced = getUnionType(c, reducedTypes);
  if ((reduced.flags & TypeFlags.Union) !== 0) (reduced as UnionType).resolvedReducedType = reduced;
  return reduced;
}

/**
 * Whether some property of the intersection `t` reduces it to never:
 * `getPropertiesOfUnionOrIntersectionType(c, t).some(isNeverReducedProperty)`, except that for an
 * intersection of object types, the properties that only one constituent has aren't looked up. An
 * intersection takes such a property as it is (createUnionOrIntersectionProperty returns it), and only
 * a synthetic property can reduce an intersection; looking it up, once the first property's lookup
 * has resolved every constituent, creates no types, so it is left to the lookups by name or to a
 * later getPropertiesOfUnionOrIntersectionType, which create the same symbols then. The lookups that
 * remain run in the same order and create the same types.
 */
function isNeverReducedIntersection(c: Checker, t: IntersectionType): boolean {
  const types = t.types;
  let lazy = t.resolvedProperties === undefined;
  for (const current of types)
    if ((current.flags & TypeFlags.Object) === 0 || (current.objectFlags & ObjectFlags.Mapped) !== 0) lazy = false;
  let props: Symbol[];
  if (!lazy) props = getPropertiesOfUnionOrIntersectionType(c, t);
  else {
    // getPropertiesOfUnionOrIntersectionType; the reduced apparent type of these constituents is
    // themselves.
    const checked = new Set<string>();
    props = [];
    let resolved = false;
    let skipped = false;
    for (let k = 0; k < types.length; k++) {
      const sources = getPropertySourcesOfObjectType(c, types[k]!);
      const owners = c.propertyOwners;
      for (let i = 0; i < sources.length; i++) {
        const name = sources[i]!.name;
        if (checked.has(name)) continue;
        checked.add(name);
        if (resolved && isUnreducingSingleProperty(c, types, k, sources, owners, i)) {
          skipped = true;
          continue;
        }
        const prop = getPropertyOfUnionOrIntersectionType(c, t, name, true);
        resolved = true;
        if (prop !== undefined) props.push(prop);
      }
    }
    if (!skipped) t.resolvedProperties = props;
  }
  for (const p of props) if (isNeverReducedProperty(c, p)) return true;
  return false;
}

/**
 * Whether property `i` of constituent `k` (`sources` and `owners`, from getPropertySourcesOfObjectType)
 * of an intersection of object types is the only
 * property of its name among the constituents, the intersection's property of that name is therefore
 * that property itself, and that property can't reduce the intersection. Constituents still resolving
 * their members, and properties declared by assignments (whose readonly check checks expressions),
 * don't qualify.
 */
function isUnreducingSingleProperty(
  c: Checker,
  types: Type[],
  k: number,
  sources: Symbol[],
  owners: (PendingMembers | undefined)[] | undefined,
  i: number,
): boolean {
  if ((propertyCheckFlagsAt(sources, owners, i) & (CheckFlags.NonUniformAndLiteral | CheckFlags.ContainsPrivate)) !== 0)
    return false;
  if ((types[k]!.objectFlags & ObjectFlags.UnresolvedMembers) !== 0) return false;
  const source = sources[i]!;
  for (const d of source.declarations) if (d.kind === SyntaxKind.CallExpression) return false;
  // Earlier constituents don't have the name (it would have been seen there). The later ones are
  // resolved (by the first lookup), and their properties are their value members with unreserved names.
  for (let j = k + 1; j < types.length; j++) {
    const other = types[j]!;
    if ((other.objectFlags & ObjectFlags.UnresolvedMembers) !== 0) return false;
    const resolved = resolveStructuredTypeMembers(c, other);
    const pending = resolved.pendingMembers as PendingInstantiatedMembers | undefined;
    const symbol = pending !== undefined ? pending.peek(source.name) : resolved.membersValue?.get(source.name);
    if (symbol !== undefined && symbolIsValue(c, symbol)) return false;
  }
  return true;
}

function isNeverReducedProperty(c: Checker, prop: Symbol): boolean {
  return isDiscriminantWithNeverType(c, prop) || isConflictingPrivateProperty(prop);
}

export function isDiscriminantWithNeverType(c: Checker, prop: Symbol): boolean {
  // A synthetic required property with non-uniform literal types, none never, reducing to never.
  return (
    (prop.flags & SymbolFlags.Optional) === 0 &&
    (prop.checkFlags & (CheckFlags.NonUniformAndLiteral | CheckFlags.HasNeverType)) ===
      CheckFlags.NonUniformAndLiteral &&
    (getTypeOfSymbol(c, prop).flags & TypeFlags.Never) !== 0
  );
}

export function isConflictingPrivateProperty(prop: Symbol): boolean {
  return prop.valueDeclaration === undefined && (prop.checkFlags & CheckFlags.ContainsPrivate) !== 0;
}

export function getReducedApparentType(c: Checker, t: Type): Type {
  // Apparent types may be unreduced, so reduce before and after.
  return getReducedType(c, getApparentType(c, getReducedType(c, t)));
}

// ---- Base constraints

export function getBaseConstraintOfType(c: Checker, t: Type): Type | undefined {
  if (
    (t.flags &
      (TypeFlags.InstantiableNonPrimitive |
        TypeFlags.UnionOrIntersection |
        TypeFlags.TemplateLiteral |
        TypeFlags.StringMapping |
        TypeFlags.Index)) !==
      0 ||
    isGenericTupleType(t)
  ) {
    const constraint = getResolvedBaseConstraint(c, t);
    return constraint !== c.noConstraintType && constraint !== c.circularConstraintType ? constraint : undefined;
  }
  return undefined;
}

export function getBaseConstraintOrType(c: Checker, t: Type): Type {
  return getBaseConstraintOfType(c, t) ?? t;
}

/** `t` with each constituent replaced by its base constraint. */
export function mapToBaseConstraintOrType(c: Checker, t: Type): Type {
  return mapType(c, t, (u) => getBaseConstraintOrType(c, u));
}

function hasConstrainedTypeData(t: Type): boolean {
  return (
    (t.flags & (TypeFlags.Intrinsic | TypeFlags.Literal | TypeFlags.UniqueESSymbol | TypeFlags.Enum)) === 0 ||
    (t.flags & TypeFlags.StructuredOrInstantiable) !== 0
  );
}

export function getResolvedBaseConstraint(c: Checker, t: Type, stack?: RecursionId[]): Type {
  if (!hasConstrainedTypeData(t)) return t;
  if (t.resolvedBaseConstraint !== undefined) return t.resolvedBaseConstraint;
  if (!pushTypeResolution(c, t, TypeSystemPropertyName.ResolvedBaseConstraint)) return c.circularConstraintType;
  let constraint: Type | undefined;
  // At least 10 levels; up to 50 without deeply nested types on the stack.
  const identity = getRecursionIdentity(t);
  const current = stack ?? [];
  if (current.length < 10 || (current.length < 50 && !current.includes(identity)))
    constraint = computeBaseConstraint(c, getSimplifiedType(c, t, false), current.concat([identity]));
  if (!popTypeResolution(c)) {
    if ((t.flags & TypeFlags.TypeParameter) !== 0) {
      const errorNode = getConstraintDeclaration(t);
      if (errorNode !== undefined)
        c.error(errorNode, Diagnostics.Type_parameter_0_has_a_circular_constraint, typeToString(c, t));
    }
    constraint = c.circularConstraintType;
  }
  if (constraint === undefined) constraint = c.noConstraintType;
  if (t.resolvedBaseConstraint === undefined) t.resolvedBaseConstraint = constraint;
  return constraint;
}

function computeBaseConstraint(c: Checker, t: Type, stack: RecursionId[]): Type | undefined {
  const flags = t.flags;
  if ((flags & TypeFlags.TypeParameter) !== 0) {
    const constraint = getConstraintFromTypeParameter(c, t);
    return (t as TypeParameter).isThisType ? constraint : getNextBaseConstraint(c, constraint, stack);
  }
  if ((flags & TypeFlags.UnionOrIntersection) !== 0) {
    const types = typesOf(t);
    const constraints: Type[] = [];
    let different = false;
    for (const s of types) {
      const constraint = getNextBaseConstraint(c, s, stack);
      if (constraint !== undefined) {
        if (constraint !== s) different = true;
        constraints.push(constraint);
      } else different = true;
    }
    if (!different) return t;
    if ((flags & TypeFlags.Union) !== 0 && constraints.length === types.length) return getUnionType(c, constraints);
    if ((flags & TypeFlags.Intersection) !== 0 && constraints.length !== 0) return getIntersectionType(c, constraints);
    return undefined;
  }
  if ((flags & TypeFlags.Index) !== 0) {
    const target = (t as IndexType).target;
    if (isGenericMappedType(c, target)) {
      if (
        getNameTypeFromMappedType(c, target as MappedType) !== undefined &&
        !isMappedTypeWithKeyofConstraintDeclaration(c, target as MappedType)
      )
        return getNextBaseConstraint(c, getIndexForMappedType(c, target as MappedType), stack);
    }
    return c.stringNumberSymbolType;
  }
  if ((flags & TypeFlags.TemplateLiteral) !== 0) {
    const template = t as TemplateLiteralType;
    const constraints: Type[] = [];
    for (const s of template.types) {
      const constraint = getNextBaseConstraint(c, s, stack);
      if (constraint !== undefined) constraints.push(constraint);
    }
    return constraints.length === template.types.length
      ? getTemplateLiteralType(c, template.texts, constraints)
      : c.stringType;
  }
  if ((flags & TypeFlags.StringMapping) !== 0) {
    const target = (t as StringMappingType).target;
    const constraint = getNextBaseConstraint(c, target, stack);
    return constraint !== undefined && constraint !== target
      ? getStringMappingType(c, t.symbol!, constraint)
      : c.stringType;
  }
  if ((flags & TypeFlags.IndexedAccess) !== 0) {
    const access = t as IndexedAccessType;
    if (isMappedTypeGenericIndexedAccess(c, t))
      return getNextBaseConstraint(
        c,
        substituteIndexedMappedType(c, access.objectType as MappedType, access.indexType),
        stack,
      );
    const baseObjectType = getNextBaseConstraint(c, access.objectType, stack);
    const baseIndexType = getNextBaseConstraint(c, access.indexType, stack);
    if (baseObjectType === undefined || baseIndexType === undefined) return undefined;
    return getNextBaseConstraint(
      c,
      getIndexedAccessTypeOrUndefined(c, baseObjectType, baseIndexType, access.accessFlags),
      stack,
    );
  }
  if ((flags & TypeFlags.Conditional) !== 0) {
    if (c.conditionalConstraintDepth >= 100) return undefined;
    c.conditionalConstraintDepth++;
    const constraint = getConstraintFromConditionalType(c, t);
    c.conditionalConstraintDepth--;
    return getNextBaseConstraint(c, constraint, stack);
  }
  if ((flags & TypeFlags.Substitution) !== 0) return getNextBaseConstraint(c, getSubstitutionIntersection(c, t), stack);
  if (isGenericTupleType(t)) {
    // Substitute constraints of variadic elements only when they're arrays or non-variadic tuples.
    const elementTypes = getElementTypes(c, t);
    const infos = tupleTargetOf(t).elementInfos;
    const newElements: Type[] = [];
    for (let i = 0; i < elementTypes.length; i++) {
      const v = elementTypes[i]!;
      let element = v;
      if ((v.flags & TypeFlags.TypeParameter) !== 0 && (infos[i]!.flags & ElementFlags.Variadic) !== 0) {
        const constraint = getNextBaseConstraint(c, v, stack);
        if (
          constraint !== undefined &&
          constraint !== v &&
          everyType(constraint, (n) => isArrayOrTupleType(c, n) && !isGenericTupleType(n))
        )
          element = constraint;
      }
      newElements.push(element);
    }
    return createTupleTypeEx(c, newElements, infos, tupleTargetOf(t).readonly);
  }
  return t;
}

function getNextBaseConstraint(c: Checker, t: Type | undefined, stack: RecursionId[]): Type | undefined {
  if (t === undefined) return undefined;
  const constraint = getResolvedBaseConstraint(c, t, stack);
  return constraint === c.noConstraintType || constraint === c.circularConstraintType ? undefined : constraint;
}

export function getConstraintOfType(c: Checker, t: Type): Type | undefined {
  if ((t.flags & TypeFlags.TypeParameter) !== 0) return getConstraintOfTypeParameterGuarded(c, t);
  if ((t.flags & TypeFlags.IndexedAccess) !== 0) return getConstraintOfIndexedAccess(c, t as IndexedAccessType);
  if ((t.flags & TypeFlags.Conditional) !== 0) return getConstraintOfConditionalTypeLazy(c, t);
  return getBaseConstraintOfType(c, t);
}

import { getConstraintOfTypeParameter as getConstraintOfTypeParameterGuarded } from './checker-declared-types.js';
import {
  getConstraintOfIndexedAccess,
  getConstraintOfConditionalType as getConstraintOfConditionalTypeLazy,
} from './checker-type-operators.js';

export function isReadonlyArray(c: Checker, t: Type): boolean {
  return isReadonlyArrayType(c, t);
}

export function getTypeFromNodeOrUndefined(c: Checker, node: Node | undefined): Type | undefined {
  return node !== undefined ? getTypeFromTypeNode(c, node) : undefined;
}

export {
  getReturnTypeOfSignature,
  getSymbolOfDeclaration,
  getLateBoundSymbol,
  instantiateTypes,
  createSignatureInstantiation,
  getUnionTypeEx,
  mapType,
};
export type { Symbol };
