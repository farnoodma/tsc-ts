// Declared types: classes, interfaces, type aliases, enums and type parameters, with their base
// types, constraints and defaults.
import { getInferredTypeParameterConstraint } from './checker-inference.js';
import {
  EnumDeclaration,
  type Node,
  NodeFlags,
  TypeParameterDeclaration,
  getExpression,
  getInitializer,
  getLocals,
  getName,
  getText,
  getType,
  getTypeArguments as getTypeArgumentNodes,
  getTypeParameters as getTypeParameterNodes,
  HeritageClause,
  MappedTypeNode,
  getHeritageClauses,
} from './ast.js';
import { getSourceFileOfNode, isEnumConst, isObjectLiteralMethod } from './binder-utilities.js';
import { Diagnostics } from './diagnostics.js';
import { type Symbol, SymbolFlags } from './symbol.js';
import { SyntaxKind } from './syntax-kind.js';
import type { Checker } from './checker.js';
import {
  ElementFlags,
  InterfaceType,
  type LiteralType,
  ObjectFlags,
  type Signature,
  SignatureKind,
  TupleType,
  type Type,
  TypeAlias,
  TypeFlags,
  TypeParameter,
  type TypeReference,
  emptyTypes,
  newTypeMapper,
  TypeListCache,
} from './checker-types.js';
import {
  UnionReduction,
  createArrayTypeEx,
  getFreshTypeOfLiteralType,
  getNumberEnumLiteralType,
  getStringEnumLiteralType,
  getTargetType,
  getTypeArguments,
  getUnionType,
  getUnionTypeEx,
  isErrorType,
  newObjectType,
  typeListKey,
  typesOf,
  typeListHash,
} from './checker-type-factory.js';
import {
  TypeSystemPropertyName,
  getFirstIdentifier,
  getMergedSymbol,
  getParentOfSymbol,
  getSymbolOfDeclaration,
  popTypeResolution,
  pushTypeResolution,
  resolveEntityName,
} from './checker-symbols.js';
import { getTypeFromTypeNode, getTypeFromClassOrInterfaceReference, isTypeAlias } from './checker-type-nodes.js';
import { instantiateType } from './instantiation.js';
import { symbolToString, typeToString } from './type-printer.js';
import {
  getApparentType,
  getBaseConstraintOfType,
  getReducedType,
  getResolvedBaseConstraint,
  getReturnTypeOfSignature,
  getSignaturesOfType,
  resolveStructuredTypeMembers,
} from './checker-members.js';
import { checkExpression } from './checker-expressions.js';
import { isContextSensitive } from './checker-functions.js';
import { getTypeOfSymbol } from './checker-symbol-types.js';
import { getIndexedAccessType, isGenericMappedType } from './checker-type-operators.js';
import { getSignatureInstantiation } from './checker-signatures.js';
import { evaluateEnumMember, EvaluatedKind } from './checker-evaluator.js';
import { checkTypeAssignableTo } from './relations.js';

export { getParentOfSymbol };

export function getDeclaredTypeOfSymbol(c: Checker, symbol: Symbol): Type {
  return tryGetDeclaredTypeOfSymbol(c, symbol) ?? c.errorType;
}

export function tryGetDeclaredTypeOfSymbol(c: Checker, symbol: Symbol): Type | undefined {
  const flags = symbol.flags;
  if ((flags & (SymbolFlags.Class | SymbolFlags.Interface)) !== 0) return getDeclaredTypeOfClassOrInterface(c, symbol);
  if ((flags & SymbolFlags.TypeParameter) !== 0) return getDeclaredTypeOfTypeParameter(c, symbol);
  if ((flags & SymbolFlags.TypeAlias) !== 0) return getDeclaredTypeOfTypeAlias(c, symbol);
  if ((flags & SymbolFlags.Enum) !== 0) return getDeclaredTypeOfEnum(c, symbol);
  if ((flags & SymbolFlags.EnumMember) !== 0) return getDeclaredTypeOfEnumMember(c, symbol);
  if ((flags & SymbolFlags.Alias) !== 0) return getDeclaredTypeOfAlias(c, symbol);
  return undefined;
}

function getDeclaredTypeOfAlias(c: Checker, symbol: Symbol): Type {
  const links = c.symbolLinks(symbol);
  if (links.declaredType === undefined) {
    const target = resolveAliasForType(c, symbol);
    links.declaredType = target !== undefined ? getDeclaredTypeOfSymbol(c, target) : c.errorType;
  }
  return links.declaredType;
}

function resolveAliasForType(c: Checker, symbol: Symbol): Symbol | undefined {
  // Imported to avoid a static cycle at module load; resolveAlias is declaration-only.
  return resolveAliasLazy(c, symbol);
}

import { resolveAlias as resolveAliasLazy } from './checker-symbols.js';

// ---- Classes and interfaces

export function getDeclaredTypeOfClassOrInterface(c: Checker, symbol: Symbol): InterfaceType {
  const links = c.symbolLinks(symbol);
  if (links.declaredType === undefined) {
    const kind = (symbol.flags & SymbolFlags.Class) !== 0 ? ObjectFlags.Class : ObjectFlags.Interface;
    const type = newObjectType(c, kind, symbol) as InterfaceType;
    links.declaredType = type;
    const outerTypeParameters = getOuterTypeParametersOfClassOrInterface(c, symbol);
    const typeParameters = appendLocalTypeParameters(c, outerTypeParameters.slice(), symbol);
    // Classes always get a `this` type; interfaces when they may reference `this`.
    if (typeParameters.length !== 0 || kind === ObjectFlags.Class || !isThislessInterface(c, symbol)) {
      type.objectFlags |= ObjectFlags.Reference;
      const thisType = c.newTypeParameter(symbol);
      thisType.isThisType = true;
      thisType.constraint = type;
      type.thisType = thisType;
      typeParameters.push(thisType);
      type.allTypeParameters = typeParameters;
      type.outerTypeParameterCount = outerTypeParameters.length;
      type.resolvedTypeArguments = type.typeParameters();
      type.instantiations = new TypeListCache<Type>();
      type.instantiations.set(
        typeListHash(type.resolvedTypeArguments, undefined, 0),
        type.resolvedTypeArguments,
        undefined,
        0,
        type,
      );
      type.target = type;
    }
  }
  return links.declaredType as InterfaceType;
}

function isThislessInterface(c: Checker, symbol: Symbol): boolean {
  for (const declaration of symbol.declarations) {
    if (declaration.kind !== SyntaxKind.InterfaceDeclaration) continue;
    if ((declaration.flags & NodeFlags.ContainsThis) !== 0) return false;
    for (const node of getExtendsHeritageClauseElements(declaration)) {
      const expression = getExpression(node)!;
      if (isEntityNameExpression(expression)) {
        const baseSymbol = resolveEntityName(c, expression, SymbolFlags.Type, true, false, undefined);
        if (
          baseSymbol === undefined ||
          (baseSymbol.flags & SymbolFlags.Interface) === 0 ||
          getDeclaredTypeOfClassOrInterface(c, baseSymbol).thisType !== undefined
        )
          return false;
      }
    }
  }
  return true;
}

export function isEntityNameExpression(node: Node): boolean {
  if (node.kind === SyntaxKind.Identifier) return true;
  if (node.kind === SyntaxKind.PropertyAccessExpression) {
    const name = getName(node);
    return name !== undefined && name.kind === SyntaxKind.Identifier && isEntityNameExpression(getExpression(node)!);
  }
  return false;
}

export function getHeritageClauseElements(node: Node, token: SyntaxKind): Node[] {
  const clauses = getHeritageClauses(node);
  if (clauses === undefined) return emptyNodes;
  for (const clause of clauses.nodes)
    if ((clause as HeritageClause).token === token) return (clause as HeritageClause).types.nodes;
  return emptyNodes;
}

const emptyNodes: Node[] = [];

export function getExtendsHeritageClauseElements(node: Node): Node[] {
  return getHeritageClauseElements(node, SyntaxKind.ExtendsKeyword);
}

export function getExtendsHeritageClauseElement(node: Node): Node | undefined {
  const elements = getExtendsHeritageClauseElements(node);
  return elements.length !== 0 ? elements[0]! : undefined;
}

export function getClassLikeDeclarationOfSymbol(symbol: Symbol): Node | undefined {
  for (const d of symbol.declarations)
    if (d.kind === SyntaxKind.ClassDeclaration || d.kind === SyntaxKind.ClassExpression) return d;
  return undefined;
}

function getOuterTypeParametersOfClassOrInterface(c: Checker, symbol: Symbol): Type[] {
  let declaration = symbol.valueDeclaration;
  if ((symbol.flags & (SymbolFlags.Class | SymbolFlags.Function)) === 0) {
    declaration = undefined;
    for (const d of symbol.declarations) {
      if (d.kind === SyntaxKind.InterfaceDeclaration) {
        declaration = d;
        break;
      }
      if (d.kind === SyntaxKind.VariableDeclaration) {
        const initializer = getInitializer(d);
        if (
          initializer !== undefined &&
          (initializer.kind === SyntaxKind.FunctionExpression || initializer.kind === SyntaxKind.ArrowFunction)
        ) {
          declaration = d;
          break;
        }
      }
    }
  }
  if (declaration === undefined) return [];
  return getOuterTypeParameters(c, declaration, false);
}

/** Type parameters of the declarations enclosing `node`, outermost first. */
export function getOuterTypeParameters(c: Checker, node: Node, includeThisTypes: boolean): Type[] {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    const kind = current.kind;
    switch (kind) {
      case SyntaxKind.ClassDeclaration:
      case SyntaxKind.ClassExpression:
      case SyntaxKind.InterfaceDeclaration:
      case SyntaxKind.CallSignature:
      case SyntaxKind.ConstructSignature:
      case SyntaxKind.MethodSignature:
      case SyntaxKind.FunctionType:
      case SyntaxKind.ConstructorType:
      case SyntaxKind.FunctionDeclaration:
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.FunctionExpression:
      case SyntaxKind.ArrowFunction:
      case SyntaxKind.TypeAliasDeclaration:
      case SyntaxKind.JSTypeAliasDeclaration:
      case SyntaxKind.MappedType:
      case SyntaxKind.ConditionalType: {
        const outer = getOuterTypeParameters(c, current, includeThisTypes);
        // A contextually typed function has the type parameters of its contextual signature.
        if (
          (kind === SyntaxKind.FunctionExpression ||
            kind === SyntaxKind.ArrowFunction ||
            isObjectLiteralMethod(current)) &&
          isContextSensitive(c, current)
        ) {
          const signatures = getSignaturesOfType(
            c,
            getTypeOfSymbol(c, getSymbolOfDeclaration(c, current)!),
            SignatureKind.Call,
          );
          if (signatures.length !== 0 && signatures[0]!.typeParameters.length !== 0) {
            for (const t of signatures[0]!.typeParameters) outer.push(t);
            return outer;
          }
        }
        if (kind === SyntaxKind.MappedType) {
          const typeParameter = (current as MappedTypeNode).typeParameter;
          outer.push(getDeclaredTypeOfTypeParameter(c, getSymbolOfDeclaration(c, typeParameter)!));
          return outer;
        }
        if (kind === SyntaxKind.ConditionalType) {
          for (const t of getInferTypeParameters(c, current)) outer.push(t);
          return outer;
        }
        appendTypeParameters(c, outer, getTypeParameterNodes(current)?.nodes);
        if (
          includeThisTypes &&
          (kind === SyntaxKind.ClassDeclaration ||
            kind === SyntaxKind.ClassExpression ||
            kind === SyntaxKind.InterfaceDeclaration)
        ) {
          const thisType = getDeclaredTypeOfClassOrInterface(c, getSymbolOfDeclaration(c, current)!).thisType;
          if (thisType !== undefined) outer.push(thisType);
        }
        return outer;
      }
    }
  }
  return [];
}

export function getInferTypeParameters(c: Checker, node: Node): Type[] {
  const result: Type[] = [];
  const locals = getLocals(node);
  if (locals !== undefined)
    for (const symbol of locals.values())
      if ((symbol.flags & SymbolFlags.TypeParameter) !== 0) result.push(getDeclaredTypeOfSymbol(c, symbol));
  return result;
}

export function getLocalTypeParametersOfClassOrInterfaceOrTypeAlias(c: Checker, symbol: Symbol): Type[] {
  return appendLocalTypeParameters(c, [], symbol);
}

function appendLocalTypeParameters(c: Checker, types: Type[], symbol: Symbol): Type[] {
  for (const node of symbol.declarations) {
    if (
      node.kind === SyntaxKind.InterfaceDeclaration ||
      node.kind === SyntaxKind.ClassDeclaration ||
      node.kind === SyntaxKind.ClassExpression ||
      isTypeAlias(node)
    )
      appendTypeParameters(c, types, getTypeParameterNodes(node)?.nodes);
  }
  return types;
}

function appendTypeParameters(c: Checker, types: Type[], declarations: Node[] | undefined): void {
  if (declarations === undefined) return;
  for (const declaration of declarations) {
    const t = getDeclaredTypeOfTypeParameter(c, getSymbolOfDeclaration(c, declaration)!);
    if (!types.includes(t)) types.push(t);
  }
}

// ---- Type parameters, aliases and enums

export function getDeclaredTypeOfTypeParameter(c: Checker, symbol: Symbol): TypeParameter {
  const links = c.symbolLinks(symbol);
  if (links.declaredType === undefined) links.declaredType = c.newTypeParameter(symbol);
  return links.declaredType as TypeParameter;
}

export function getDeclaredTypeOfTypeAlias(c: Checker, symbol: Symbol): Type {
  const links = c.symbolLinks(symbol);
  if (links.declaredType !== undefined) return links.declaredType;
  if (!pushTypeResolution(c, symbol, TypeSystemPropertyName.DeclaredType)) return c.errorType;
  let declaration: Node | undefined;
  for (const d of symbol.declarations)
    if (d.kind === SyntaxKind.TypeAliasDeclaration || d.kind === SyntaxKind.JSTypeAliasDeclaration) {
      declaration = d;
      break;
    }
  const typeNode = declaration !== undefined ? getType(declaration) : undefined;
  let type = typeNode !== undefined ? getTypeFromTypeNode(c, typeNode) : c.errorType;
  if (popTypeResolution(c)) {
    const typeParameters = getLocalTypeParametersOfClassOrInterfaceOrTypeAlias(c, symbol);
    if (typeParameters.length !== 0) {
      // The declared type is the instantiation with the type parameters themselves.
      links.typeParameters = typeParameters;
      links.instantiations = new Map<string, Type>();
      links.instantiations.set(typeListKey(typeParameters), type);
    }
    // `BuiltinIteratorReturn` is `undefined` with `strictBuiltinIteratorReturn`, else `any`.
    if (type === c.intrinsicMarkerType && symbol.name === 'BuiltinIteratorReturn')
      type = c.strictBuiltinIteratorReturn ? c.undefinedType : c.anyType;
  } else {
    const errorNode = declaration !== undefined ? (getName(declaration) ?? declaration) : undefined;
    c.error(errorNode, Diagnostics.Type_alias_0_circularly_references_itself, symbolToString(c, symbol));
    type = c.errorType;
  }
  if (links.declaredType === undefined) links.declaredType = type;
  return links.declaredType;
}

export function getDeclaredTypeOfEnum(c: Checker, symbol: Symbol): Type {
  const links = c.symbolLinks(symbol);
  if (links.declaredType !== undefined) return links.declaredType;
  const memberTypes: Type[] = [];
  for (const declaration of symbol.declarations) {
    if (declaration.kind !== SyntaxKind.EnumDeclaration) continue;
    for (const member of (declaration as EnumDeclaration).members.nodes) {
      if (!hasBindableName(member)) continue;
      const memberSymbol = getSymbolOfDeclaration(c, member)!;
      computeEnumMemberValues(c, declaration);
      const memberLinks = c.nodeLinks(member);
      let memberType: Type;
      if (memberLinks.enumValueKind === EvaluatedKind.String)
        memberType = getStringEnumLiteralType(c, memberLinks.enumStringValue, symbol, memberSymbol);
      else if (memberLinks.enumValueKind === EvaluatedKind.Number)
        memberType = getNumberEnumLiteralType(c, memberLinks.enumNumberValue, symbol, memberSymbol);
      else memberType = createComputedEnumType(c, memberSymbol);
      c.symbolLinks(memberSymbol).declaredType = getFreshTypeOfLiteralType(c, memberType);
      memberTypes.push(memberType);
    }
  }
  const enumType =
    memberTypes.length !== 0
      ? getUnionTypeEx(c, memberTypes, UnionReduction.Literal, new TypeAlias(symbol, emptyTypes), undefined)
      : createComputedEnumType(c, symbol);
  if ((enumType.flags & TypeFlags.Union) !== 0) {
    enumType.flags |= TypeFlags.EnumLiteral;
    enumType.symbol = symbol;
  }
  links.declaredType = enumType;
  return enumType;
}

export function hasBindableName(node: Node): boolean {
  const name = getName(node);
  return name === undefined || name.kind !== SyntaxKind.ComputedPropertyName || isLiteralComputed(name);
}

function isLiteralComputed(name: Node): boolean {
  const e = getExpression(name)!;
  return (
    e.kind === SyntaxKind.StringLiteral ||
    e.kind === SyntaxKind.NumericLiteral ||
    e.kind === SyntaxKind.NoSubstitutionTemplateLiteral
  );
}

function createComputedEnumType(c: Checker, symbol: Symbol): Type {
  const regular = c.newLiteralType(TypeFlags.Enum, '', 0, symbol);
  const fresh = c.newLiteralType(TypeFlags.Enum, '', 0, symbol);
  fresh.regularType = regular;
  regular.freshType = fresh;
  fresh.freshType = fresh;
  return regular;
}

export function getDeclaredTypeOfEnumMember(c: Checker, symbol: Symbol): Type {
  const links = c.symbolLinks(symbol);
  if (links.declaredType === undefined) {
    const enumType = getDeclaredTypeOfEnum(c, getParentOfSymbol(c, symbol)!);
    if (links.declaredType === undefined) links.declaredType = enumType;
  }
  return links.declaredType;
}

/** Computes the values of an enum's members into their node links. */
export function computeEnumMemberValues(c: Checker, node: Node): void {
  const nodeLinks = c.nodeLinks(node);
  if ((nodeLinks.flags & (1 << 10)) !== 0) return;
  nodeLinks.flags |= 1 << 10;
  let hasAuto = true;
  let autoValue = 0;
  for (const member of (node as EnumDeclaration).members.nodes) {
    const links = c.nodeLinks(member);
    computeEnumMemberValue(c, member, hasAuto, autoValue);
    if (links.enumValueKind === EvaluatedKind.Number) {
      autoValue = links.enumNumberValue + 1;
      hasAuto = true;
    } else hasAuto = false;
  }
}

function computeEnumMemberValue(c: Checker, member: Node, hasAuto: boolean, autoValue: number): void {
  const links = c.nodeLinks(member);
  const name = getName(member)!;
  if (name.kind === SyntaxKind.ComputedPropertyName && !isLiteralComputed(name))
    c.error(name, Diagnostics.Computed_property_names_are_not_allowed_in_enums);
  else if (name.kind === SyntaxKind.BigIntLiteral) c.error(name, Diagnostics.An_enum_member_cannot_have_a_numeric_name);
  else {
    const text = name.kind === SyntaxKind.ComputedPropertyName ? getText(getExpression(name)!) : getText(name);
    if (isNumericLiteralName(text) && text !== 'Infinity' && text !== '-Infinity' && text !== 'NaN')
      c.error(name, Diagnostics.An_enum_member_cannot_have_a_numeric_name);
  }
  const initializer = getInitializer(member);
  if (initializer !== undefined) {
    computeConstantEnumMemberValue(c, member, initializer);
    return;
  }
  // Members of ambient non-const enums without initializers are computed.
  if ((member.parent!.flags & NodeFlags.Ambient) !== 0 && !isEnumConst(member.parent!)) {
    links.enumValueKind = EvaluatedKind.None;
    return;
  }
  if (!hasAuto) {
    c.error(name, Diagnostics.Enum_member_must_have_initializer);
    links.enumValueKind = EvaluatedKind.None;
    return;
  }
  links.enumValueKind = EvaluatedKind.Number;
  links.enumNumberValue = autoValue;
}

function computeConstantEnumMemberValue(c: Checker, member: Node, initializer: Node): void {
  const links = c.nodeLinks(member);
  const isConstEnum = isEnumConst(member.parent!);
  const result = evaluateEnumMember(c, initializer, member);
  links.enumValueKind = result.kind;
  links.enumStringValue = result.stringValue;
  links.enumNumberValue = result.numberValue;
  if (result.kind !== EvaluatedKind.None) {
    if (isConstEnum && result.kind === EvaluatedKind.Number && !Number.isFinite(result.numberValue))
      c.error(
        initializer,
        result.numberValue !== result.numberValue
          ? Diagnostics.X_const_enum_member_initializer_was_evaluated_to_disallowed_value_NaN
          : Diagnostics.X_const_enum_member_initializer_was_evaluated_to_a_non_finite_value,
      );
  } else if (isConstEnum)
    c.error(initializer, Diagnostics.X_const_enum_member_initializers_must_be_constant_expressions);
  else if ((member.parent!.flags & NodeFlags.Ambient) !== 0)
    c.error(initializer, Diagnostics.In_ambient_enum_declarations_member_initializer_must_be_constant_expression);
  else
    checkTypeAssignableTo(
      c,
      checkExpression(c, initializer),
      c.numberType,
      initializer,
      Diagnostics.Type_0_is_not_assignable_to_type_1_as_required_for_computed_enum_member_values,
    );
}

export function isNumericLiteralName(name: string): boolean {
  // A name is numeric when it round-trips through Number.
  return name.length !== 0 && String(Number(name)) === name;
}

// ---- Base types

export function getBaseTypes(c: Checker, t: Type): Type[] {
  if ((t.objectFlags & (ObjectFlags.ClassOrInterface | ObjectFlags.Tuple)) === 0) return emptyTypes;
  const data = t as InterfaceType;
  if (!data.baseTypesResolved) {
    if (!pushTypeResolution(c, t, TypeSystemPropertyName.ResolvedBaseTypes)) return data.resolvedBaseTypes;
    if ((t.objectFlags & ObjectFlags.Tuple) !== 0) data.resolvedBaseTypes = [getTupleBaseType(c, t as TupleType)];
    else {
      if ((t.symbol!.flags & SymbolFlags.Class) !== 0) resolveBaseTypesOfClass(c, data);
      if ((t.symbol!.flags & SymbolFlags.Interface) !== 0) resolveBaseTypesOfInterface(c, data);
    }
    if (!popTypeResolution(c))
      for (const declaration of t.symbol!.declarations)
        if (declaration.kind === SyntaxKind.ClassDeclaration || declaration.kind === SyntaxKind.InterfaceDeclaration)
          reportCircularBaseType(c, declaration, t);
    // Circular defaults may leave members partially resolved; reset them.
    t.objectFlags &= ~ObjectFlags.MembersResolved;
    data.baseTypesResolved = true;
  }
  return data.resolvedBaseTypes;
}

function getTupleBaseType(c: Checker, t: TupleType): Type {
  const typeParameters = t.typeParameters();
  const elementTypes: Type[] = [];
  for (let i = 0; i < typeParameters.length; i++)
    elementTypes.push(
      (t.elementInfos[i]!.flags & ElementFlags.Variadic) !== 0
        ? getIndexedAccessType(c, typeParameters[i]!, c.numberType)
        : typeParameters[i]!,
    );
  return createArrayTypeEx(c, getUnionType(c, elementTypes), t.readonly);
}

function resolveBaseTypesOfClass(c: Checker, t: InterfaceType): void {
  const baseConstructorType = getApparentType(c, getBaseConstructorTypeOfClass(c, t));
  if ((baseConstructorType.flags & (TypeFlags.Object | TypeFlags.Intersection | TypeFlags.Any)) === 0) return;
  const baseTypeNode = getExtendsHeritageClauseElement(getClassLikeDeclarationOfSymbol(t.symbol!)!)!;
  let baseType: Type;
  const constructorSymbol = baseConstructorType.symbol;
  const originalBaseType = constructorSymbol !== undefined ? getDeclaredTypeOfSymbol(c, constructorSymbol) : undefined;
  if (
    constructorSymbol !== undefined &&
    (constructorSymbol.flags & SymbolFlags.Class) !== 0 &&
    areAllOuterTypeParametersApplied(c, originalBaseType!)
  ) {
    // A class with no captured type arguments: apply type arguments like a type reference.
    baseType = getTypeFromClassOrInterfaceReference(c, baseTypeNode, constructorSymbol);
  } else if ((baseConstructorType.flags & TypeFlags.Any) !== 0) baseType = baseConstructorType;
  else {
    const constructors = getInstantiatedConstructorsForTypeArguments(
      c,
      baseConstructorType,
      getTypeArgumentNodes(baseTypeNode)?.nodes,
      baseTypeNode,
    );
    if (constructors.length === 0) {
      c.error(getExpression(baseTypeNode), Diagnostics.No_base_constructor_has_the_specified_number_of_type_arguments);
      return;
    }
    baseType = getReturnTypeOfSignature(c, constructors[0]!);
  }
  if (isErrorType(c, baseType)) return;
  const reducedBaseType = getReducedType(c, baseType);
  if (!isValidBaseType(c, reducedBaseType)) {
    c.error(
      getExpression(baseTypeNode),
      Diagnostics.Base_constructor_return_type_0_is_not_an_object_type_or_intersection_of_object_types_with_statically_known_members,
      typeToString(c, reducedBaseType),
    );
    return;
  }
  if (t.id === reducedBaseType.id || hasBaseType(c, reducedBaseType, t)) {
    c.error(
      t.symbol!.valueDeclaration,
      Diagnostics.Type_0_recursively_references_itself_as_a_base_type,
      typeToString(c, t),
    );
    return;
  }
  t.resolvedBaseTypes = [reducedBaseType];
}

export function getInstantiatedConstructorsForTypeArguments(
  c: Checker,
  t: Type,
  typeArgumentNodes: Node[] | undefined,
  location: Node,
): Signature[] {
  const nodes = typeArgumentNodes ?? emptyNodes;
  const typeArguments: Type[] = [];
  for (const n of nodes) typeArguments.push(getTypeFromTypeNode(c, n));
  const result: Signature[] = [];
  for (const sig of getSignaturesOfType(c, t, SignatureKind.Construct)) {
    if (nodes.length < getMinTypeArgumentCount(c, sig.typeParameters) || nodes.length > sig.typeParameters.length)
      continue;
    result.push(
      sig.typeParameters.length !== 0 ? getSignatureInstantiation(c, sig, typeArguments, isInJS(location)) : sig,
    );
  }
  return result;
}

function isInJS(node: Node): boolean {
  return (node.flags & NodeFlags.JavaScriptFile) !== 0;
}

function resolveBaseTypesOfInterface(c: Checker, t: InterfaceType): void {
  for (const declaration of t.symbol!.declarations) {
    if (declaration.kind !== SyntaxKind.InterfaceDeclaration) continue;
    for (const node of getExtendsHeritageClauseElements(declaration)) {
      const baseType = getReducedType(c, getTypeFromTypeNode(c, node));
      if (isErrorType(c, baseType)) continue;
      if (isValidBaseType(c, baseType)) {
        if (t.id !== baseType.id && !hasBaseType(c, baseType, t)) {
          if (t.resolvedBaseTypes === emptyTypes) t.resolvedBaseTypes = [baseType];
          else t.resolvedBaseTypes.push(baseType);
        } else reportCircularBaseType(c, declaration, t);
      } else
        c.error(
          node,
          Diagnostics.An_interface_can_only_extend_an_object_type_or_intersection_of_object_types_with_statically_known_members,
        );
    }
  }
}

function areAllOuterTypeParametersApplied(c: Checker, t: Type): boolean {
  // Unapplied type parameters still have the symbol of the matching argument; only the last needs checking.
  const outer = (t as InterfaceType).outerTypeParameters();
  if (outer.length === 0) return true;
  const last = outer.length - 1;
  return outer[last]!.symbol !== getTypeArguments(c, t)[last]!.symbol;
}

function reportCircularBaseType(c: Checker, node: Node, t: Type): void {
  c.error(node, Diagnostics.Type_0_recursively_references_itself_as_a_base_type, typeToString(c, t, undefined, 1 << 1));
}

export function isValidBaseType(c: Checker, t: Type): boolean {
  if ((t.flags & TypeFlags.TypeParameter) !== 0) {
    const constraint = getBaseConstraintOfType(c, t);
    if (constraint !== undefined) return isValidBaseType(c, constraint);
  }
  if ((t.flags & (TypeFlags.Object | TypeFlags.NonPrimitive | TypeFlags.Any)) !== 0) return !isGenericMappedType(c, t);
  if ((t.flags & TypeFlags.Intersection) !== 0) {
    for (const u of typesOf(t)) if (!isValidBaseType(c, u)) return false;
    return true;
  }
  return false;
}

export function hasBaseType(c: Checker, t: Type, checkBase: Type): boolean {
  if (
    (t.objectFlags & (ObjectFlags.ClassOrInterface | ObjectFlags.Reference)) !== 0 &&
    (t.flags & TypeFlags.Object) !== 0
  ) {
    const target = getTargetType(t);
    if (target === checkBase) return true;
    for (const b of getBaseTypes(c, target)) if (hasBaseType(c, b, checkBase)) return true;
    return false;
  }
  if ((t.flags & TypeFlags.Intersection) !== 0) {
    for (const u of typesOf(t)) if (hasBaseType(c, u, checkBase)) return true;
  }
  return false;
}

export function getBaseConstructorTypeOfClass(c: Checker, t: InterfaceType): Type {
  if (t.resolvedBaseConstructorType !== undefined) return t.resolvedBaseConstructorType;
  const declaration = getClassLikeDeclarationOfSymbol(t.symbol!);
  const baseTypeNode = declaration !== undefined ? getExtendsHeritageClauseElement(declaration) : undefined;
  if (baseTypeNode === undefined) {
    t.resolvedBaseConstructorType = c.undefinedType;
    return c.undefinedType;
  }
  if (!pushTypeResolution(c, t, TypeSystemPropertyName.ResolvedBaseConstructorType)) return c.errorType;
  const baseConstructorType = checkExpression(c, getExpression(baseTypeNode)!);
  if ((baseConstructorType.flags & (TypeFlags.Object | TypeFlags.Intersection)) !== 0)
    resolveStructuredTypeMembers(c, baseConstructorType);
  if (!popTypeResolution(c)) {
    c.error(
      t.symbol!.valueDeclaration,
      Diagnostics.X_0_is_referenced_directly_or_indirectly_in_its_own_base_expression,
      symbolToString(c, t.symbol!),
    );
    if (t.resolvedBaseConstructorType === undefined) t.resolvedBaseConstructorType = c.errorType;
    return t.resolvedBaseConstructorType;
  }
  if (
    (baseConstructorType.flags & TypeFlags.Any) === 0 &&
    baseConstructorType !== c.nullWideningType &&
    !isConstructorType(c, baseConstructorType)
  ) {
    c.error(
      getExpression(baseTypeNode),
      Diagnostics.Type_0_is_not_a_constructor_function_type,
      typeToString(c, baseConstructorType),
    );
    if (t.resolvedBaseConstructorType === undefined) t.resolvedBaseConstructorType = c.errorType;
    return t.resolvedBaseConstructorType;
  }
  if (t.resolvedBaseConstructorType === undefined) t.resolvedBaseConstructorType = baseConstructorType;
  return t.resolvedBaseConstructorType;
}

export function isConstructorType(c: Checker, t: Type): boolean {
  if (getSignaturesOfType(c, t, SignatureKind.Construct).length > 0) return true;
  if ((t.flags & TypeFlags.TypeVariable) !== 0) {
    const constraint = getBaseConstraintOfType(c, t);
    return constraint !== undefined && isMixinConstructorType(c, constraint);
  }
  return false;
}

export function isMixinConstructorType(c: Checker, t: Type): boolean {
  const signatures = getSignaturesOfType(c, t, SignatureKind.Construct);
  if (signatures.length !== 1) return false;
  const s = signatures[0]!;
  if (s.typeParameters.length !== 0 || s.parameters.length !== 1 || !s.hasRestParameter()) return false;
  const paramType = getTypeOfParameterLazy(c, s.parameters[0]!);
  return (paramType.flags & TypeFlags.Any) !== 0 || getElementTypeOfArrayType(c, paramType) === c.anyType;
}

import { getTypeOfParameter as getTypeOfParameterLazy } from './checker-symbol-types.js';

export function getElementTypeOfArrayType(c: Checker, t: Type): Type | undefined {
  if ((t.objectFlags & ObjectFlags.Reference) === 0) return undefined;
  const target = (t as TypeReference).target;
  if (target !== c.globalArrayType && target !== c.globalReadonlyArrayType) return undefined;
  return getTypeArguments(c, t)[0]!;
}

// ---- Constraints and defaults

export function getConstraintOfTypeParameter(c: Checker, typeParameter: Type): Type | undefined {
  return hasNonCircularBaseConstraint(c, typeParameter) ? getConstraintFromTypeParameter(c, typeParameter) : undefined;
}

export function hasNonCircularBaseConstraint(c: Checker, t: Type): boolean {
  return getResolvedBaseConstraint(c, t) !== c.circularConstraintType;
}

export function getConstraintDeclaration(t: Type): Node | undefined {
  if (t.symbol !== undefined)
    for (const d of t.symbol.declarations)
      if (d.kind === SyntaxKind.TypeParameter) {
        const constraint = (d as TypeParameterDeclaration).constraint;
        if (constraint !== undefined) return constraint;
      }
  return undefined;
}

/** The declared constraint; use getConstraintOfTypeParameter, which guards against circularity. */
export function getConstraintFromTypeParameter(c: Checker, t: Type): Type | undefined {
  if ((t.flags & TypeFlags.TypeParameter) === 0) return undefined;
  const tp = t as TypeParameter;
  if (tp.constraint === undefined) {
    let constraint: Type | undefined;
    if (tp.target !== undefined) {
      const targetConstraint = getConstraintOfTypeParameter(c, tp.target);
      constraint = targetConstraint !== undefined ? instantiateType(c, targetConstraint, tp.mapper) : undefined;
    } else {
      const declaration = getConstraintDeclaration(t);
      if (declaration !== undefined) {
        constraint = getTypeFromTypeNode(c, declaration);
        if ((constraint.flags & TypeFlags.Any) !== 0 && !isErrorType(c, constraint))
          // Mapped type keys use string | number | symbol; others unknown.
          constraint =
            declaration.parent!.parent!.kind === SyntaxKind.MappedType ? c.stringNumberSymbolType : c.unknownType;
      } else constraint = getInferredTypeParameterConstraint(c, t);
    }
    tp.constraint = constraint ?? c.noConstraintType;
  }
  return tp.constraint !== c.noConstraintType ? tp.constraint : undefined;
}

export function getDefaultFromTypeParameter(c: Checker, t: Type): Type | undefined {
  if ((t.flags & TypeFlags.TypeParameter) === 0) return undefined;
  const defaultType = getResolvedTypeParameterDefault(c, t as TypeParameter);
  return defaultType !== c.noConstraintType && defaultType !== c.circularConstraintType ? defaultType : undefined;
}

export function getResolvedTypeParameterDefault(c: Checker, t: TypeParameter): Type {
  if (t.resolvedDefaultType === undefined) {
    if (t.target !== undefined) {
      const targetDefault = getResolvedTypeParameterDefault(c, t.target as TypeParameter);
      t.resolvedDefaultType = instantiateType(c, targetDefault, t.mapper);
    } else {
      // Block recursion while resolving.
      t.resolvedDefaultType = c.resolvingDefaultType;
      let defaultType: Type = c.noConstraintType;
      if (t.symbol !== undefined)
        for (const d of t.symbol.declarations)
          if (d.kind === SyntaxKind.TypeParameter) {
            const node = (d as TypeParameterDeclaration).defaultType;
            if (node !== undefined) {
              defaultType = getTypeFromTypeNode(c, node);
              break;
            }
          }
      if (t.resolvedDefaultType === c.resolvingDefaultType) t.resolvedDefaultType = defaultType;
    }
  } else if (t.resolvedDefaultType === c.resolvingDefaultType) t.resolvedDefaultType = c.circularConstraintType;
  return t.resolvedDefaultType;
}

export function getDefaultOrUnknownFromTypeParameter(c: Checker, t: Type): Type {
  return getDefaultFromTypeParameter(c, t) ?? c.unknownType;
}

export function getMinTypeArgumentCount(c: Checker, typeParameters: readonly Type[]): number {
  let minTypeArgumentCount = 0;
  for (let i = 0; i < typeParameters.length; i++)
    if (!hasTypeParameterDefault(typeParameters[i]!)) minTypeArgumentCount = i + 1;
  return minTypeArgumentCount;
}

/** Whether a type parameter is declared with a default, without resolving it. */
function hasTypeParameterDefault(t: Type): boolean {
  if (t.symbol === undefined) return false;
  for (const d of t.symbol.declarations)
    if (d.kind === SyntaxKind.TypeParameter && (d as TypeParameterDeclaration).defaultType !== undefined) return true;
  return false;
}

export function fillMissingTypeArguments(
  c: Checker,
  typeArguments: Type[],
  typeParameters: readonly Type[],
  minTypeArgumentCount: number,
  isJavaScriptImplicitAny: boolean,
): Type[] {
  const numTypeParameters = typeParameters.length;
  if (numTypeParameters === 0) return [];
  const numTypeArguments = typeArguments.length;
  if (!isJavaScriptImplicitAny && numTypeArguments >= numTypeParameters) return typeArguments;
  const result = typeArguments.slice();
  // Invalid forward references in defaults map to the error type.
  for (let i = numTypeArguments; i < numTypeParameters; i++) result.push(c.errorType);
  const baseDefaultType = isJavaScriptImplicitAny ? c.anyType : c.unknownType;
  for (let i = numTypeArguments; i < numTypeParameters; i++) {
    const defaultType = getDefaultFromTypeParameter(c, typeParameters[i]!);
    result[i] =
      defaultType !== undefined
        ? instantiateType(c, defaultType, newTypeMapper(typeParameters as Type[], result))
        : baseDefaultType;
  }
  return result;
}

export { getFirstIdentifier, getMergedSymbol, getSourceFileOfNode };
export type { LiteralType };
