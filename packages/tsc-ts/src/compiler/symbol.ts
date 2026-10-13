import type { Int32 } from '@scriptc/types';
// Symbols: what the binder declares for each named entity, and the tables that hold them.
import type { Node } from './ast.js';

export const enum SymbolFlags {
  None = 0,
  /** A `var` or parameter. */
  FunctionScopedVariable = 1 << 0,
  /** A `let` or `const`. */
  BlockScopedVariable = 1 << 1,
  /** A property or enum member. */
  Property = 1 << 2,
  EnumMember = 1 << 3,
  Function = 1 << 4,
  Class = 1 << 5,
  Interface = 1 << 6,
  ConstEnum = 1 << 7,
  RegularEnum = 1 << 8,
  /** An instantiated namespace. */
  ValueModule = 1 << 9,
  /** A namespace with only types. */
  NamespaceModule = 1 << 10,
  /** A type literal or mapped type. */
  TypeLiteral = 1 << 11,
  ObjectLiteral = 1 << 12,
  Method = 1 << 13,
  Constructor = 1 << 14,
  GetAccessor = 1 << 15,
  SetAccessor = 1 << 16,
  /** A call, construct or index signature. */
  Signature = 1 << 17,
  TypeParameter = 1 << 18,
  TypeAlias = 1 << 19,
  /** The local half of an exported value; see `Binder.declareModuleMember`. */
  ExportValue = 1 << 20,
  /** An alias for another symbol, e.g. an import. */
  Alias = 1 << 21,
  /** A class's `prototype` property. */
  Prototype = 1 << 22,
  /** `export *` declarations. */
  ExportStar = 1 << 23,
  Optional = 1 << 24,
  /** Created by the checker. */
  Transient = 1 << 25,
  /** A JavaScript assignment that declares a property, e.g. `fn.prop = 1`. */
  Assignment = 1 << 26,
  /** CommonJS `module` or `module.exports`. */
  ModuleExports = 1 << 27,
  /** A namespace whose only values are const enums. */
  ConstEnumOnlyModule = 1 << 28,
  /** A JavaScript `this.x` property that a method of the same name replaces. */
  ReplaceableByMethod = 1 << 29,
  /** Marks a lookup in the global scope. */
  GlobalLookup = 1 << 30,
  All = (1 << 30) - 1,

  Enum = RegularEnum | ConstEnum,
  Variable = FunctionScopedVariable | BlockScopedVariable,
  Value = Variable |
    Property |
    EnumMember |
    ObjectLiteral |
    Function |
    Class |
    Enum |
    ValueModule |
    Method |
    GetAccessor |
    SetAccessor,
  Type = Class | Interface | Enum | EnumMember | TypeLiteral | TypeParameter | TypeAlias,
  Namespace = ValueModule | NamespaceModule | Enum,
  Module = ValueModule | NamespaceModule,
  Accessor = GetAccessor | SetAccessor,

  // What a declaration of each kind can't merge with.
  FunctionScopedVariableExcludes = Value & ~FunctionScopedVariable,
  BlockScopedVariableExcludes = Value,
  ParameterExcludes = Value,
  PropertyExcludes = Value & ~(Property | Accessor),
  EnumMemberExcludes = Value | Type,
  FunctionExcludes = Value & ~(Function | ValueModule | Class),
  /** Class-interface merging is checked by the checker. */
  ClassExcludes = (Value | Type) & ~(ValueModule | Interface | Function),
  InterfaceExcludes = Type & ~(Interface | Class),
  RegularEnumExcludes = (Value | Type) & ~(RegularEnum | ValueModule),
  ConstEnumExcludes = (Value | Type) & ~ConstEnum,
  ValueModuleExcludes = Value & ~(Function | Class | RegularEnum | ValueModule),
  NamespaceModuleExcludes = None,
  MethodExcludes = Value & ~Method,
  GetAccessorExcludes = Value & ~(SetAccessor | Property),
  SetAccessorExcludes = Value & ~(GetAccessor | Property),
  AccessorExcludes = Value & ~Property,
  TypeParameterExcludes = Type & ~TypeParameter,
  TypeAliasExcludes = Type,
  AliasExcludes = Alias,

  ModuleMember = Variable | Function | Class | Interface | Enum | Module | TypeAlias | Alias,
  ExportHasLocal = Function | Class | Enum | ValueModule,
  BlockScoped = BlockScopedVariable | Class | Enum,
  PropertyOrAccessor = Property | Accessor,
  ClassMember = Method | Accessor | Property,
  ExportSupportsDefaultModifier = Class | Function | Interface,
  ExportDoesNotSupportDefaultModifier = ~ExportSupportsDefaultModifier,
  /** What the language service classifies semantically. */
  Classifiable = Class | Enum | TypeAlias | Interface | TypeParameter | Module | Alias,
  LateBindingContainer = Class | Interface | TypeLiteral | ObjectLiteral | Function,
}

/** Flags of transient symbols created by the checker. */
export const enum CheckFlags {
  None = 0,
  Instantiated = 1 << 0,
  /** A property of a union or intersection type. */
  SyntheticProperty = 1 << 1,
  SyntheticMethod = 1 << 2,
  Readonly = 1 << 3,
  /** In some but not all constituents. */
  ReadPartial = 1 << 4,
  /** In some constituents, and only an index signature in others. */
  WritePartial = 1 << 5,
  HasNonUniformType = 1 << 6,
  HasLiteralType = 1 << 7,
  ContainsPublic = 1 << 8,
  ContainsProtected = 1 << 9,
  ContainsPrivate = 1 << 10,
  ContainsStatic = 1 << 11,
  /** Late-bound from a computed property name. */
  Late = 1 << 12,
  ReverseMapped = 1 << 13,
  OptionalParameter = 1 << 14,
  RestParameter = 1 << 15,
  /** The type is computed on demand. */
  DeferredType = 1 << 16,
  HasNeverType = 1 << 17,
  Mapped = 1 << 18,
  StripOptional = 1 << 19,
  Unresolved = 1 << 20,
  IsDiscriminantComputed = 1 << 21,
  IsDiscriminant = 1 << 22,
  /** Created from an index signature. */
  IndexSymbol = 1 << 23,
  Synthetic = SyntheticProperty | SyntheticMethod,
  NonUniformAndLiteral = HasNonUniformType | HasLiteralType,
  Partial = ReadPartial | WritePartial,
}

/** Fields of Symbol that few symbols set (about one in twenty), allocated on first write. */
export class SymbolRareFields {
  members: SymbolTable | undefined = undefined;
  exports: SymbolTable | undefined = undefined;
  exportSymbol: Symbol | undefined = undefined;
}

export class Symbol {
  flags: SymbolFlags;
  checkFlags: CheckFlags;
  readonly name: string;
  declarations: Node[];
  valueDeclaration: Node | undefined;
  parent: Symbol | undefined;
  private rareFields: SymbolRareFields | undefined;
  /** Assigned on first use by `getSymbolId`; 0 until then. */
  id: Int32;

  constructor(flags: SymbolFlags, name: string) {
    this.flags = flags;
    this.checkFlags = CheckFlags.None;
    this.name = name;
    this.declarations = noDeclarations;
    this.valueDeclaration = undefined;
    this.parent = undefined;
    this.rareFields = undefined;
    this.id = 0;
  }

  private rareFieldsOrNew(): SymbolRareFields {
    let group = this.rareFields;
    if (group === undefined) {
      group = new SymbolRareFields();
      this.rareFields = group;
    }
    return group;
  }

  get members(): SymbolTable | undefined {
    const group = this.rareFields;
    return group === undefined ? undefined : group.members;
  }

  set members(value: SymbolTable | undefined) {
    if (value === undefined && this.rareFields === undefined) return;
    this.rareFieldsOrNew().members = value;
  }

  get exports(): SymbolTable | undefined {
    const group = this.rareFields;
    return group === undefined ? undefined : group.exports;
  }

  set exports(value: SymbolTable | undefined) {
    if (value === undefined && this.rareFields === undefined) return;
    this.rareFieldsOrNew().exports = value;
  }

  /** For the local symbol of an exported declaration, the exported symbol. */
  get exportSymbol(): Symbol | undefined {
    const group = this.rareFields;
    return group === undefined ? undefined : group.exportSymbol;
  }

  set exportSymbol(value: Symbol | undefined) {
    if (value === undefined && this.rareFields === undefined) return;
    this.rareFieldsOrNew().exportSymbol = value;
  }

  /** Whether this is the symbol of an external module, named by its quoted path. */
  isExternalModule(): boolean {
    return (this.flags & SymbolFlags.Module) !== 0 && this.name.charCodeAt(0) === 0x22;
  }

  /** The flags of this symbol and its export symbol. */
  combinedLocalAndExportSymbolFlags(): SymbolFlags {
    const exportSymbol = this.exportSymbol;
    return exportSymbol === undefined ? this.flags : this.flags | exportSymbol.flags;
  }
}

export type SymbolTable = Map<string, Symbol>;

/**
 * The declarations of a symbol without any: shared, so never modified. Add declarations with
 * `addDeclaration`, which gives the symbol its own array on the first one.
 */
const noDeclarations: Node[] = [];

/** Appends `node` to the declarations of `symbol`. */
export function addDeclaration(symbol: Symbol, node: Node): void {
  const declarations = symbol.declarations;
  if (declarations.length === 0) symbol.declarations = [node];
  else declarations.push(node);
}

let nextSymbolId: Int32 = 0;

/** A program-wide id, assigned to each symbol when first requested. */
export function getSymbolId(symbol: Symbol): number {
  let id = symbol.id;
  if (id === 0) {
    id = nextSymbolId = (nextSymbolId + 1) | 0;
    symbol.id = id | 0;
  }
  return id;
}

/** The exports table of `symbol`, created if missing. */
export function getExports(symbol: Symbol): SymbolTable {
  let exports = symbol.exports;
  if (exports === undefined) {
    exports = new Map<string, Symbol>();
    symbol.exports = exports;
  }
  return exports;
}

/** The members table of `symbol`, created if missing. */
export function getMembers(symbol: Symbol): SymbolTable {
  let members = symbol.members;
  if (members === undefined) {
    members = new Map<string, Symbol>();
    symbol.members = members;
  }
  return members;
}

/**
 * Starts internal symbol names. A noncharacter, so it never starts an identifier and is
 * vanishingly unlikely in a string-literal property name.
 */
export const internalSymbolNamePrefix = '￾';

export const enum InternalSymbolName {
  /** Call signatures. */
  Call = '￾call',
  /** Constructor implementations. */
  Constructor = '￾constructor',
  /** Construct signatures. */
  New = '￾new',
  /** Index signatures. */
  Index = '￾index',
  /** `export *` declarations. */
  ExportStar = '￾export',
  /** The global scope's self-reference. */
  Global = '￾global',
  /** A missing name. */
  Missing = '￾missing',
  /** An anonymous type literal. */
  Type = '￾type',
  /** An anonymous object literal. */
  Object = '￾object',
  /** An anonymous JSX attributes object literal. */
  JSXAttributes = '￾jsxAttributes',
  /** An unnamed class expression. */
  Class = '￾class',
  /** An unnamed function expression. */
  Function = '￾function',
  /** A computed property name that isn't a literal. */
  Computed = '￾computed',
  /** Late-bound JavaScript assignment declarations. */
  AssignmentDeclaration = '￾assignment',
  InstantiationExpression = '￾instantiationExpression',
  ImportAttributes = '￾importAttributes',
  ExportEquals = 'export=',
  Default = 'default',
  This = 'this',
  ModuleExports = 'module.exports',
}

/** `name` with a leading internal prefix replaced by `__`. */
export function escapeInternalSymbolName(name: string): string {
  return name.startsWith(internalSymbolNamePrefix) ? '__' + name.substring(1) : name;
}

/** `name` with every internal prefix replaced by `__`. */
export function escapeAllInternalSymbolNames(name: string): string {
  return name.indexOf(internalSymbolNamePrefix) < 0 ? name : name.replaceAll(internalSymbolNamePrefix, '__');
}

/**
 * The escaped `__String` form of a symbol name: internal names get `__`, and names that
 * already start with `__` get one more `_`.
 */
export function escapeSymbolName(name: string): string {
  if (name.startsWith(internalSymbolNamePrefix)) return '__' + name.substring(1);
  if (name.startsWith('__')) return '_' + name;
  return name;
}
