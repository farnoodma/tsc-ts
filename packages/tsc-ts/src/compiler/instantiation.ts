// Instantiation: mappers that need the checker, and `instantiateType` for every kind of type.
import {
  type Node,
  NodeVisitor,
  getBody,
  getInitializer,
  getParameters,
  getType,
  getTypeArguments as getTypeArgumentNodes,
  getTypeParameters as getTypeParameterNodes,
  ArrayTypeNode,
  ConditionalTypeNode,
  TypeParameterDeclaration,
  TypeQueryNode,
} from './ast.js';
import { Diagnostics } from './diagnostics.js';
import { CheckFlags, type Symbol, SymbolFlags, getSymbolId } from './symbol.js';
import { SyntaxKind } from './syntax-kind.js';
import type { Checker, VarianceReporting } from './checker.js';
import {
  CachedTypeKind,
  cachedTypeKey,
  IndexInfo,
  type IndexType,
  type IndexedAccessType,
  type InstantiationExpressionType,
  type MappedType,
  ObjectFlags,
  type ObjectType,
  Signature,
  type StringMappingType,
  type SubstitutionType,
  type TemplateLiteralType,
  type Type,
  TypeAlias,
  TypeFlags,
  TypeMapper,
  TypeParameter,
  type TypeReference,
  type UnionType,
  type ConditionalType,
  emptyTypes,
  newTypeMapper,
  SimpleTypeMapper,
  TypeListCache,
} from './checker-types.js';
import {
  IntersectionFlags,
  UnionReduction,
  createDeferredTypeReference,
  createNormalizedTypeReference,
  getIntersectionType,
  getIntersectionTypeEx,
  getPropagatingFlagsOfTypes,
  getTemplateLiteralType,
  getTypeArguments,
  getUnionTypeEx,
  newObjectType,
  aliasKey,
  typesOf,
  typeListHash,
} from './checker-type-factory.js';
import { getOuterTypeParameters } from './checker-declared-types.js';
import { getSymbolFromTypeReference, getResolvedSymbolOfIdentifier } from './checker-type-nodes.js';
import {
  getConditionalTypeInstantiation,
  getIndexType,
  getIndexedAccessTypeEx,
  getStringMappingType,
  getSubstitutionType,
  getTypeParameterFromMappedType,
  instantiateMappedType,
  instantiateReverseMappedType,
  isGenericType,
  isNoInferType,
  getNoInferType,
} from './checker-type-operators.js';
import { getConstraintDeclaration } from './checker-declared-types.js';
import { isTypeAssignableTo } from './relations.js';
import { getFirstIdentifier } from './checker-symbols.js';

// ---- Mappers that need the checker

/** Applies `m1`, then instantiates its result with `m2`, or applies `m2` when `m1` doesn't map. */
export class CompositeTypeMapper extends TypeMapper {
  readonly c: Checker;
  readonly m1: TypeMapper;
  readonly m2: TypeMapper;

  constructor(c: Checker, m1: TypeMapper, m2: TypeMapper) {
    super();
    this.c = c;
    this.m1 = m1;
    this.m2 = m2;
  }

  map(type: Type): Type {
    const t1 = this.m1.map(type);
    return t1 !== type ? instantiateType(this.c, t1, this.m2) : this.m2.map(type);
  }
}

/** Records unreliable or unmeasurable variance when it sees a marker type. */
export class ReportingMapper extends TypeMapper {
  readonly c: Checker;
  readonly flag: VarianceReporting;

  constructor(c: Checker, flag: VarianceReporting) {
    super();
    this.c = c;
    this.flag = flag;
  }

  map(type: Type): Type {
    const c = this.c;
    if (type === c.markerSuperType || type === c.markerSubType || type === c.markerOtherType)
      c.reliabilityFlags |= this.flag;
    return type;
  }
}

/** Maps type parameters to copies without constraints. */
export class RestrictiveMapper extends TypeMapper {
  readonly c: Checker;

  constructor(c: Checker) {
    super();
    this.c = c;
  }

  map(type: Type): Type {
    return (type.flags & TypeFlags.TypeParameter) !== 0
      ? getRestrictiveTypeParameter(this.c, type as TypeParameter)
      : type;
  }
}

/** Maps type parameters to the wildcard type. */
export class PermissiveMapper extends TypeMapper {
  readonly c: Checker;

  constructor(c: Checker) {
    super();
    this.c = c;
  }

  map(type: Type): Type {
    return (type.flags & TypeFlags.TypeParameter) !== 0 ? this.c.wildcardType : type;
  }
}

/** Maps type parameters to the unique literal `never`, for reducibility checks. */
export class UniqueLiteralMapper extends TypeMapper {
  readonly c: Checker;

  constructor(c: Checker) {
    super();
    this.c = c;
  }

  map(type: Type): Type {
    return (type.flags & TypeFlags.TypeParameter) !== 0 ? this.c.uniqueLiteralType : type;
  }
}

export function combineTypeMappers(c: Checker, m1: TypeMapper | undefined, m2: TypeMapper): TypeMapper {
  return m1 !== undefined ? new CompositeTypeMapper(c, m1, m2) : m2;
}

// ---- instantiateType

export function instantiateType(c: Checker, type: Type, mapper: TypeMapper | undefined): Type {
  return instantiateTypeWithAlias(c, type, mapper, undefined);
}

export function instantiateTypeWithAlias(
  c: Checker,
  type: Type,
  mapper: TypeMapper | undefined,
  alias: TypeAlias | undefined,
): Type {
  if (mapper === undefined) return type;
  // Aliases with type arguments may be copied with new arguments even when the type itself has no type variables.
  if (!couldContainTypeVariables(c, type) && !aliasCouldContainTypeVariables(c, type)) return type;
  if (c.instantiationDepth === 100 || c.instantiationCount >= 5000000) {
    // Probably infinitely expanding generic types; stop with the error type.
    c.error(c.currentNode, Diagnostics.Type_instantiation_is_excessively_deep_and_possibly_infinite);
    return c.errorType;
  }
  const index = c.activeMappers.lastIndexOf(mapper);
  if (index === -1) {
    // A newly active mapper has no cached instantiations; its cache is created when a nested
    // instantiation with the same mapper stores one.
    c.activeMappers.push(mapper);
    c.activeMapperCaches.push(undefined);
    c.activeMapperAliasCaches.push(undefined);
  } else {
    let cached: Type | undefined = undefined;
    if (alias === undefined) {
      const cache = c.activeMapperCaches[index];
      if (cache !== undefined) cached = cache.get(type.id);
    } else {
      const cache = c.activeMapperAliasCaches[index];
      if (cache !== undefined) cached = cache.get(type.id + aliasKey(alias));
    }
    if (cached !== undefined) return cached;
  }
  c.instantiationCount++;
  c.instantiationDepth++;
  const result = instantiateTypeWorker(c, type, mapper, alias);
  if (index === -1) {
    c.activeMappers.pop();
    const cache = c.activeMapperCaches.pop();
    if (cache !== undefined) {
      cache.clear();
      c.freeMapperCaches.push(cache);
    }
    c.activeMapperAliasCaches.pop();
  } else if (alias === undefined) {
    let cache = c.activeMapperCaches[index];
    if (cache === undefined) {
      cache = c.freeMapperCaches.length !== 0 ? c.freeMapperCaches.pop()! : new Map<number, Type>();
      c.activeMapperCaches[index] = cache;
    }
    cache.set(type.id, result);
  } else {
    let cache = c.activeMapperAliasCaches[index];
    if (cache === undefined) {
      cache = new Map<string, Type>();
      c.activeMapperAliasCaches[index] = cache;
    }
    cache.set(type.id + aliasKey(alias), result);
  }
  c.instantiationDepth--;
  return result;
}

function aliasCouldContainTypeVariables(c: Checker, type: Type): boolean {
  const alias = type.alias;
  if (alias === undefined || alias.typeArguments.length === 0) return false;
  for (const t of alias.typeArguments) if (couldContainTypeVariables(c, t)) return true;
  return false;
}

/** Whether `type` could reference a type parameter we infer for. Cached on the type. */
export function couldContainTypeVariables(c: Checker, type: Type): boolean {
  if ((type.flags & TypeFlags.StructuredOrInstantiable) === 0) return false;
  const objectFlags = type.objectFlags;
  if ((objectFlags & ObjectFlags.CouldContainTypeVariablesComputed) !== 0)
    return (objectFlags & ObjectFlags.CouldContainTypeVariables) !== 0;
  let result = false;
  if ((type.flags & TypeFlags.Instantiable) !== 0) result = true;
  else if ((type.flags & TypeFlags.Object) !== 0) {
    if (!isNonGenericTopLevelType(type)) {
      if ((objectFlags & ObjectFlags.Reference) !== 0) {
        if ((type as TypeReference).node !== undefined) result = true;
        else
          for (const t of getTypeArguments(c, type))
            if (couldContainTypeVariables(c, t)) {
              result = true;
              break;
            }
      } else if ((objectFlags & ObjectFlags.Anonymous) !== 0 && type.symbol !== undefined) {
        result =
          (type.symbol.flags &
            (SymbolFlags.Function |
              SymbolFlags.Method |
              SymbolFlags.Class |
              SymbolFlags.TypeLiteral |
              SymbolFlags.ObjectLiteral)) !==
            0 && type.symbol.declarations.length !== 0;
      }
      if (!result)
        result =
          (objectFlags &
            (ObjectFlags.Mapped |
              ObjectFlags.ReverseMapped |
              ObjectFlags.ObjectRestType |
              ObjectFlags.InstantiationExpressionType)) !==
          0;
    }
  } else if (
    (type.flags & TypeFlags.UnionOrIntersection) !== 0 &&
    (type.flags & TypeFlags.EnumLiteral) === 0 &&
    !isNonGenericTopLevelType(type)
  ) {
    for (const t of typesOf(type))
      if (couldContainTypeVariables(c, t)) {
        result = true;
        break;
      }
  }
  type.objectFlags |=
    ObjectFlags.CouldContainTypeVariablesComputed | (result ? ObjectFlags.CouldContainTypeVariables : 0);
  return result;
}

/** A type written through a non-generic alias declared at the top level of a file. */
function isNonGenericTopLevelType(type: Type): boolean {
  const alias = type.alias;
  if (alias === undefined || alias.typeArguments.length !== 0) return false;
  let declaration: Node | undefined;
  for (const d of alias.symbol.declarations)
    if (d.kind === SyntaxKind.TypeAliasDeclaration || d.kind === SyntaxKind.JSTypeAliasDeclaration) {
      declaration = d;
      break;
    }
  if (declaration === undefined) return false;
  for (let n = declaration.parent; n !== undefined; n = n.parent) {
    if (n.kind === SyntaxKind.SourceFile) return true;
    if (n.kind === SyntaxKind.ModuleDeclaration) return false;
    if (n.kind !== SyntaxKind.ModuleBlock) return false;
  }
  return false;
}

function instantiateTypeWorker(c: Checker, type: Type, mapper: TypeMapper, alias: TypeAlias | undefined): Type {
  const flags = type.flags;
  if ((flags & TypeFlags.TypeParameter) !== 0) return mapper.map(type);
  if ((flags & TypeFlags.Object) !== 0) {
    const objectFlags = type.objectFlags;
    if ((objectFlags & (ObjectFlags.Reference | ObjectFlags.Anonymous | ObjectFlags.Mapped)) === 0) return type;
    if ((objectFlags & ObjectFlags.Reference) !== 0 && (type as TypeReference).node === undefined) {
      const resolved = (type as TypeReference).resolvedTypeArguments ?? emptyTypes;
      const newTypeArguments = instantiateTypes(c, resolved, mapper);
      if (newTypeArguments === resolved) return type;
      return createNormalizedTypeReference(c, (type as TypeReference).target!, newTypeArguments);
    }
    if ((objectFlags & ObjectFlags.ReverseMapped) !== 0) return instantiateReverseMappedType(c, type, mapper);
    return getObjectTypeInstantiation(c, type as ObjectType, mapper, alias);
  }
  if ((flags & TypeFlags.UnionOrIntersection) !== 0) {
    let source = type;
    if ((flags & TypeFlags.Union) !== 0) {
      const origin = (type as UnionType).origin;
      if (origin !== undefined && (origin.flags & TypeFlags.UnionOrIntersection) !== 0) source = origin;
    }
    const types = typesOf(source);
    const newTypes = instantiateTypes(c, types, mapper);
    if (newTypes === types && alias?.symbol === type.alias?.symbol) return type;
    const newAlias = alias ?? instantiateTypeAlias(c, type.alias, mapper);
    if ((source.flags & TypeFlags.Intersection) !== 0)
      return getIntersectionTypeEx(c, newTypes, IntersectionFlags.None, newAlias);
    return getUnionTypeEx(c, newTypes, UnionReduction.Literal, newAlias, undefined);
  }
  if ((flags & TypeFlags.Index) !== 0) return getIndexType(c, instantiateType(c, (type as IndexType).target, mapper));
  if ((flags & TypeFlags.IndexedAccess) !== 0) {
    const access = type as IndexedAccessType;
    return getIndexedAccessTypeEx(
      c,
      instantiateType(c, access.objectType, mapper),
      instantiateType(c, access.indexType, mapper),
      access.accessFlags,
      undefined,
      alias ?? instantiateTypeAlias(c, type.alias, mapper),
    );
  }
  if ((flags & TypeFlags.TemplateLiteral) !== 0) {
    const template = type as TemplateLiteralType;
    return getTemplateLiteralType(c, template.texts, instantiateTypes(c, template.types, mapper));
  }
  if ((flags & TypeFlags.StringMapping) !== 0)
    return getStringMappingType(c, type.symbol!, instantiateType(c, (type as StringMappingType).target, mapper));
  if ((flags & TypeFlags.Conditional) !== 0)
    return getConditionalTypeInstantiation(
      c,
      type as ConditionalType,
      combineTypeMappers(c, (type as ConditionalType).mapper, mapper),
      false,
      alias,
    );
  if ((flags & TypeFlags.Substitution) !== 0) {
    const substitution = type as SubstitutionType;
    const newBaseType = instantiateType(c, substitution.baseType, mapper);
    if (isNoInferType(c, type)) return getNoInferType(c, newBaseType);
    const newConstraint = instantiateType(c, substitution.constraint, mapper);
    // Resolves to the base type where the conditional type resolves to its true branch.
    if ((newBaseType.flags & TypeFlags.TypeVariable) !== 0 && isGenericType(c, newConstraint))
      return getSubstitutionType(c, newBaseType, newConstraint);
    if (
      (newConstraint.flags & TypeFlags.AnyOrUnknown) !== 0 ||
      isTypeAssignableTo(c, getRestrictiveInstantiation(c, newBaseType), getRestrictiveInstantiation(c, newConstraint))
    )
      return newBaseType;
    if ((newBaseType.flags & TypeFlags.TypeVariable) !== 0) return getSubstitutionType(c, newBaseType, newConstraint);
    return getIntersectionType(c, [newConstraint, newBaseType]);
  }
  return type;
}

/** Instantiates anonymous types, deferred references, instantiation expressions and mapped types. */
function getObjectTypeInstantiation(
  c: Checker,
  type: ObjectType,
  mapper: TypeMapper,
  alias: TypeAlias | undefined,
): Type {
  let declaration: Node;
  if ((type.objectFlags & ObjectFlags.Reference) !== 0) declaration = (type as TypeReference).node!;
  else if ((type.objectFlags & ObjectFlags.InstantiationExpressionType) !== 0)
    declaration = (type as InstantiationExpressionType).node!;
  else declaration = type.symbol!.declarations[0]!;
  const links = c.nodeLinks(declaration);
  let target: ObjectType;
  if ((type.objectFlags & ObjectFlags.Reference) !== 0) target = c.resolvedTypes.get(declaration.id) as ObjectType;
  else if ((type.objectFlags & ObjectFlags.Instantiated) !== 0) target = type.target as ObjectType;
  else target = type;
  let typeParameters = links.outerTypeParameters;
  if (typeParameters === undefined) {
    // On first instantiation, record the type parameters in scope, reduced to those possibly referenced.
    typeParameters = getOuterTypeParameters(c, declaration, true);
    if (target.alias === undefined || target.alias.typeArguments.length === 0) {
      if ((type.objectFlags & (ObjectFlags.Reference | ObjectFlags.InstantiationExpressionType)) !== 0) {
        const referenced: Type[] = [];
        for (const tp of typeParameters) if (isTypeParameterPossiblyReferenced(c, tp, declaration)) referenced.push(tp);
        typeParameters = referenced;
      } else if ((target.symbol!.flags & (SymbolFlags.Method | SymbolFlags.TypeLiteral)) !== 0) {
        const referenced: Type[] = [];
        for (const tp of typeParameters) {
          for (const d of type.symbol!.declarations) {
            if (isTypeParameterPossiblyReferenced(c, tp, d)) {
              referenced.push(tp);
              break;
            }
          }
        }
        typeParameters = referenced;
      }
    }
    links.outerTypeParameters = typeParameters;
  }
  if (typeParameters.length === 0) return type;
  const combinedMapper = combineTypeMappers(c, type.mapper, mapper);
  const typeArguments: Type[] = [];
  for (const tp of typeParameters) typeArguments.push(combinedMapper.map(tp));
  const newAlias = alias ?? instantiateTypeAlias(c, type.alias, mapper);
  const singleSignature = (type.objectFlags & ObjectFlags.SingleSignatureType) !== 0;
  const tag = singleSignature ? 1 : 0;
  const hash = typeListHash(typeArguments, newAlias, tag);
  let instantiations = target.instantiations;
  if (instantiations === undefined) {
    instantiations = new TypeListCache<Type>();
    instantiations.set(typeListHash(typeParameters, target.alias, 0), typeParameters, target.alias, 0, target);
    target.instantiations = instantiations;
  }
  let result = instantiations.get(hash, typeArguments, newAlias, tag);
  if (result === undefined) {
    let newMapper = newTypeMapper(typeParameters, typeArguments);
    if ((target.objectFlags & ObjectFlags.SingleSignatureType) !== 0)
      newMapper = combineTypeMappers(c, newMapper, mapper);
    if ((target.objectFlags & ObjectFlags.Reference) !== 0)
      result = createDeferredTypeReference(
        c,
        (type as TypeReference).target!,
        (type as TypeReference).node!,
        newMapper,
        newAlias,
      );
    else if ((target.objectFlags & ObjectFlags.Mapped) !== 0)
      result = instantiateMappedType(c, target as MappedType, newMapper, newAlias);
    else result = instantiateAnonymousType(c, target, newMapper, newAlias);
    instantiations.set(hash, typeArguments, newAlias, tag, result);
    if (
      (result.flags & TypeFlags.ObjectFlagsType) !== 0 &&
      (result.objectFlags & ObjectFlags.CouldContainTypeVariablesComputed) === 0
    ) {
      // Type variable containment follows from the type arguments.
      let couldContain = false;
      for (const t of typeArguments)
        if (couldContainTypeVariables(c, t)) {
          couldContain = true;
          break;
        }
      if ((result.objectFlags & (ObjectFlags.Mapped | ObjectFlags.Anonymous | ObjectFlags.Reference)) !== 0)
        result.objectFlags |=
          ObjectFlags.CouldContainTypeVariablesComputed | (couldContain ? ObjectFlags.CouldContainTypeVariables : 0);
      else if (!couldContain) result.objectFlags |= ObjectFlags.CouldContainTypeVariablesComputed;
    }
  }
  return result;
}

class ReferenceFinder extends NodeVisitor {
  readonly c: Checker;
  readonly tp: TypeParameter;

  constructor(c: Checker, tp: TypeParameter) {
    super();
    this.c = c;
    this.tp = tp;
  }

  visitNode(node: Node): boolean {
    return this.containsReference(node);
  }

  containsReference(node: Node): boolean {
    const tp = this.tp;
    switch (node.kind) {
      case SyntaxKind.ThisType:
        return tp.isThisType;
      case SyntaxKind.TypeReference: {
        const args = getTypeArgumentNodes(node);
        if (
          !tp.isThisType &&
          (args === undefined || args.nodes.length === 0) &&
          getSymbolFromTypeReference(this.c, node) === tp.symbol
        )
          return true;
        break;
      }
      case SyntaxKind.TypeQuery: {
        const firstIdentifier = getFirstIdentifier((node as TypeQueryNode).exprName);
        if (
          firstIdentifier.kind !== SyntaxKind.ThisKeyword &&
          !(firstIdentifier.kind === SyntaxKind.Identifier && firstIdentifier.text === 'this')
        ) {
          const symbol = getResolvedSymbolOfIdentifier(this.c, firstIdentifier);
          const tpDeclaration = tp.symbol!.declarations[0]!;
          let scope: Node | undefined;
          if (tpDeclaration.kind === SyntaxKind.TypeParameter) scope = tpDeclaration.parent;
          else if (tp.isThisType) scope = tpDeclaration;
          if (scope !== undefined) {
            for (const d of symbol.declarations) if (isNodeDescendantOf(d, scope)) return true;
            const args = getTypeArgumentNodes(node);
            if (args !== undefined) for (const a of args.nodes) if (this.containsReference(a)) return true;
            return false;
          }
        }
        return true;
      }
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.MethodSignature: {
        const returnType = getType(node);
        if (returnType === undefined && getBody(node) !== undefined) return true;
        const typeParameters = getTypeParameterNodes(node);
        if (typeParameters !== undefined)
          for (const n of typeParameters.nodes) if (this.containsReference(n)) return true;
        const parameters = getParameters(node);
        if (parameters !== undefined) for (const n of parameters.nodes) if (this.containsReference(n)) return true;
        return returnType !== undefined && this.containsReference(returnType);
      }
    }
    return node.forEachChild(this);
  }
}

export function isNodeDescendantOf(node: Node, ancestor: Node): boolean {
  for (let n: Node | undefined = node; n !== undefined; n = n.parent) if (n === ancestor) return true;
  return false;
}

/**
 * Whether `tp` may be referenced in `node`: true without exactly one declaration, across
 * statement blocks, or for references and type queries we can't rule out.
 */
export function isTypeParameterPossiblyReferenced(c: Checker, tp: Type, node: Node): boolean {
  const typeParameter = tp as TypeParameter;
  if (tp.symbol === undefined || tp.symbol.declarations.length !== 1) return true;
  const finder = new ReferenceFinder(c, typeParameter);
  const container = tp.symbol.declarations[0]!.parent;
  for (let n: Node | undefined = node; n !== container; n = n.parent) {
    if (n === undefined || n.kind === SyntaxKind.Block) return true;
    if (n.kind === SyntaxKind.ConditionalType && finder.containsReference((n as ConditionalTypeNode).extendsType))
      return true;
  }
  return finder.containsReference(node);
}

export function instantiateAnonymousType(
  c: Checker,
  type: ObjectType,
  mapper: TypeMapper,
  alias: TypeAlias | undefined,
): ObjectType {
  const result = newObjectType(
    c,
    (type.objectFlags & ~(ObjectFlags.CouldContainTypeVariablesComputed | ObjectFlags.CouldContainTypeVariables)) |
      ObjectFlags.Instantiated,
    type.symbol,
  );
  if ((type.objectFlags & ObjectFlags.Mapped) !== 0) {
    const mapped = result as MappedType;
    mapped.declaration = (type as MappedType).declaration;
    // As in instantiateSignature, map the type parameter to a fresh copy.
    const original = getTypeParameterFromMappedType(c, type as MappedType);
    const fresh = cloneTypeParameter(c, original);
    mapped.typeParameter = fresh;
    mapper = combineTypeMappers(c, new SimpleTypeMapper(original, fresh), mapper);
    fresh.mapper = mapper;
  } else if ((type.objectFlags & ObjectFlags.InstantiationExpressionType) !== 0)
    (result as InstantiationExpressionType).node = (type as InstantiationExpressionType).node;
  const newAlias = alias ?? instantiateTypeAlias(c, type.alias, mapper);
  result.alias = newAlias;
  if (newAlias !== undefined && newAlias.typeArguments.length !== 0)
    result.objectFlags |= getPropagatingFlagsOfTypes(newAlias.typeArguments, TypeFlags.None);
  result.target = type;
  result.mapper = mapper;
  return result;
}

export function cloneTypeParameter(c: Checker, tp: Type): TypeParameter {
  const result = c.newTypeParameter(tp.symbol);
  result.target = tp;
  return result;
}

export function instantiateTypeAlias(
  c: Checker,
  alias: TypeAlias | undefined,
  mapper: TypeMapper,
): TypeAlias | undefined {
  return alias === undefined
    ? undefined
    : new TypeAlias(alias.symbol, instantiateTypes(c, alias.typeArguments, mapper));
}

/** Instantiates each type; returns `types` itself when nothing changed. */
export function instantiateTypes(c: Checker, types: Type[], mapper: TypeMapper | undefined): Type[] {
  if (mapper === undefined) return types;
  for (let i = 0; i < types.length; i++) {
    const mapped = instantiateType(c, types[i]!, mapper);
    if (mapped !== types[i]!) {
      const result = types.slice(0, i);
      result.push(mapped);
      for (let j = i + 1; j < types.length; j++) result.push(instantiateType(c, types[j]!, mapper));
      return result;
    }
  }
  return types;
}

export function instantiateSymbols(c: Checker, symbols: Symbol[], mapper: TypeMapper): Symbol[] {
  for (let i = 0; i < symbols.length; i++) {
    const mapped = instantiateSymbol(c, symbols[i]!, mapper);
    if (mapped !== symbols[i]!) {
      const result = symbols.slice(0, i);
      result.push(mapped);
      for (let j = i + 1; j < symbols.length; j++) result.push(instantiateSymbol(c, symbols[j]!, mapper));
      return result;
    }
  }
  return symbols;
}

export function instantiateSignatures(c: Checker, signatures: Signature[], mapper: TypeMapper): Signature[] {
  for (let i = 0; i < signatures.length; i++) {
    const mapped = instantiateSignature(c, signatures[i]!, mapper);
    if (mapped !== signatures[i]!) {
      const result = signatures.slice(0, i);
      result.push(mapped);
      for (let j = i + 1; j < signatures.length; j++) result.push(instantiateSignature(c, signatures[j]!, mapper));
      return result;
    }
  }
  return signatures;
}

export function instantiateIndexInfos(c: Checker, infos: IndexInfo[], mapper: TypeMapper): IndexInfo[] {
  for (let i = 0; i < infos.length; i++) {
    const mapped = instantiateIndexInfo(c, infos[i]!, mapper);
    if (mapped !== infos[i]!) {
      const result = infos.slice(0, i);
      result.push(mapped);
      for (let j = i + 1; j < infos.length; j++) result.push(instantiateIndexInfo(c, infos[j]!, mapper));
      return result;
    }
  }
  return infos;
}

export function instantiateIndexInfo(c: Checker, info: IndexInfo, mapper: TypeMapper): IndexInfo {
  const valueType = instantiateType(c, info.valueType, mapper);
  if (valueType === info.valueType) return info;
  return new IndexInfo(info.keyType, valueType, info.isReadonly, info.declaration, info.components);
}

export function instantiateSignature(c: Checker, sig: Signature, mapper: TypeMapper): Signature {
  return instantiateSignatureEx(c, sig, mapper, mapper === c.permissiveMapper);
}

export function instantiateSignatureEx(
  c: Checker,
  sig: Signature,
  mapper: TypeMapper,
  eraseTypeParameters: boolean,
): Signature {
  let freshTypeParameters: Type[] = emptyTypes;
  if (sig.typeParameters.length !== 0 && !eraseTypeParameters) {
    // Map the type parameters to fresh copies, which keep the mapper for their constraints.
    freshTypeParameters = [];
    for (const tp of sig.typeParameters) freshTypeParameters.push(cloneTypeParameter(c, tp));
    mapper = combineTypeMappers(c, newTypeMapper(sig.typeParameters, freshTypeParameters), mapper);
    for (const tp of freshTypeParameters) (tp as TypeParameter).mapper = mapper;
  }
  // The return type and predicate are computed lazily so inferences aren't fixed early.
  const result = c.newSignature(
    sig.flags & 0x14f,
    sig.declaration,
    freshTypeParameters,
    sig.thisParameter !== undefined ? instantiateSymbol(c, sig.thisParameter, mapper) : undefined,
    instantiateSymbols(c, sig.parameters, mapper),
    undefined,
    sig.minArgumentCount,
  );
  result.target = sig;
  result.mapper = mapper;
  return result;
}

export function instantiateSymbol(c: Checker, symbol: Symbol, mapper: TypeMapper): Symbol {
  return keepsSymbolUnderInstantiation(c, symbol, mapper) ? symbol : newInstantiatedSymbol(c, symbol, mapper);
}

/**
 * Whether `instantiateSymbol` returns `symbol` itself. This depends on whether the type of `symbol`
 * is resolved yet, so lazily instantiated members record it when tsgo would instantiate them.
 */
export function keepsSymbolUnderInstantiation(c: Checker, symbol: Symbol, mapper: TypeMapper): boolean {
  const symbolId = getSymbolId(symbol);
  if (mapper.mapsThisOnly() && isThisless(symbol)) return true;
  // A resolved type that can't change under instantiation keeps the symbol.
  const type = c.symbolTypes.get(symbolId);
  if (type !== undefined && !couldContainTypeVariables(c, type)) {
    if ((symbol.flags & SymbolFlags.SetAccessor) === 0) return true;
    const writeType = c.existingSymbolLinks(symbol)?.writeType;
    if (writeType !== undefined && !couldContainTypeVariables(c, writeType)) return true;
  }
  return false;
}

/** The instantiated copy of `symbol` that `instantiateSymbol` creates when it doesn't keep it. */
export function newInstantiatedSymbol(c: Checker, symbol: Symbol, mapper: TypeMapper): Symbol {
  if ((symbol.checkFlags & CheckFlags.Instantiated) !== 0) {
    const symbolId = getSymbolId(symbol);
    // Instantiate the original with combined mappers, preserving identities.
    symbol = c.symbolTargets.get(symbolId)!;
    mapper = combineTypeMappers(c, c.symbolMappers.get(symbolId), mapper);
  }
  const result = c.newSymbol(symbol.flags, symbol.name);
  result.checkFlags =
    CheckFlags.Instantiated |
    (symbol.checkFlags &
      (CheckFlags.Readonly | CheckFlags.Late | CheckFlags.OptionalParameter | CheckFlags.RestParameter));
  result.declarations = symbol.declarations;
  result.parent = symbol.parent;
  result.valueDeclaration = symbol.valueDeclaration;
  const id = getSymbolId(result);
  c.symbolTargets.set(id, symbol);
  c.symbolMappers.set(id, mapper);
  c.symbolNameTypes.set(id, c.symbolNameTypes.get(getSymbolId(symbol)));
  return result;
}

/** Conservatively, whether a parameter or member's type can't reference `this`. */
export function isThisless(symbol: Symbol): boolean {
  if (symbol.declarations.length !== 1) return false;
  const declaration = symbol.declarations[0]!;
  switch (declaration.kind) {
    case SyntaxKind.Parameter:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertySignature:
      return isThislessVariableLikeDeclaration(declaration);
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.MethodSignature:
    case SyntaxKind.Constructor:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
      return isThislessFunctionLikeDeclaration(declaration);
  }
  return false;
}

function isThislessVariableLikeDeclaration(node: Node): boolean {
  const typeNode = getType(node);
  return typeNode !== undefined ? isThislessType(typeNode) : getInitializer(node) === undefined;
}

function isThislessType(node: Node): boolean {
  switch (node.kind) {
    case SyntaxKind.AnyKeyword:
    case SyntaxKind.UnknownKeyword:
    case SyntaxKind.StringKeyword:
    case SyntaxKind.NumberKeyword:
    case SyntaxKind.BigIntKeyword:
    case SyntaxKind.BooleanKeyword:
    case SyntaxKind.SymbolKeyword:
    case SyntaxKind.ObjectKeyword:
    case SyntaxKind.VoidKeyword:
    case SyntaxKind.UndefinedKeyword:
    case SyntaxKind.NeverKeyword:
    case SyntaxKind.LiteralType:
      return true;
    case SyntaxKind.ArrayType:
      return isThislessType((node as ArrayTypeNode).elementType);
    case SyntaxKind.TypeReference: {
      const args = getTypeArgumentNodes(node);
      if (args !== undefined) for (const a of args.nodes) if (!isThislessType(a)) return false;
      return true;
    }
  }
  return false;
}

function isThislessFunctionLikeDeclaration(node: Node): boolean {
  const returnType = getType(node);
  if (node.kind !== SyntaxKind.Constructor && (returnType === undefined || !isThislessType(returnType))) return false;
  const parameters = getParameters(node);
  if (parameters !== undefined)
    for (const p of parameters.nodes) if (!isThislessVariableLikeDeclaration(p)) return false;
  const typeParameters = getTypeParameterNodes(node);
  if (typeParameters !== undefined)
    for (const tp of typeParameters.nodes) {
      const constraint = (tp as TypeParameterDeclaration).constraint;
      if (constraint !== undefined && !isThislessType(constraint)) return false;
    }
  return true;
}

// ---- Restrictive instantiation

export function getRestrictiveInstantiation(c: Checker, type: Type): Type {
  if ((type.flags & (TypeFlags.Primitive | TypeFlags.AnyOrUnknown | TypeFlags.Never)) !== 0) return type;
  const key = cachedTypeKey(CachedTypeKind.RestrictiveInstantiation, type.id);
  const cached = c.cachedTypesById.get(key);
  if (cached !== undefined) return cached;
  const result = instantiateType(c, type, c.restrictiveMapper);
  c.cachedTypesById.set(key, result);
  // A restrictive instance is its own restrictive instance.
  c.cachedTypesById.set(cachedTypeKey(CachedTypeKind.RestrictiveInstantiation, result.id), result);
  return result;
}

export function isRestrictiveInstance(c: Checker, type: Type): boolean {
  return c.cachedTypesById.get(cachedTypeKey(CachedTypeKind.RestrictiveInstantiation, type.id)) === type;
}

function getRestrictiveTypeParameter(c: Checker, tp: TypeParameter): Type {
  if (
    (tp.constraint === undefined && getConstraintDeclaration(tp) === undefined) ||
    tp.constraint === c.noConstraintType
  )
    return tp;
  const key = cachedTypeKey(CachedTypeKind.RestrictiveTypeParameter, tp.id);
  const cached = c.cachedTypesById.get(key);
  if (cached !== undefined) return cached;
  const result = c.newTypeParameter(tp.symbol);
  result.constraint = c.noConstraintType;
  c.cachedTypesById.set(key, result);
  return result;
}

export { Signature };
