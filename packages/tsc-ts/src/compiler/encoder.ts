// Encodes a source file in TypeScript 7's binary AST format (protocol version 5), the
// `getSourceFile` payload of the API.
//
// Layout: a 44-byte header, string offsets (UTF-8 start/end pairs), string data (the
// UTF-8 file text, then strings that aren't slices of it), extended node data,
// msgpack structured data, and 28-byte node records in visit order. Node positions are
// UTF-16 offsets.
import {
  ArrayLiteralExpression,
  ArrayTypeNode,
  ArrowFunction,
  AsExpression,
  AwaitExpression,
  BinaryExpression,
  BindingElement,
  BindingPattern,
  Block,
  BreakStatement,
  CallExpression,
  CallSignatureDeclaration,
  CaseBlock,
  CaseOrDefaultClause,
  CatchClause,
  ClassDeclaration,
  ClassExpression,
  ClassStaticBlockDeclaration,
  ComputedPropertyName,
  ConditionalExpression,
  ConditionalTypeNode,
  ConstructSignatureDeclaration,
  ConstructorDeclaration,
  ConstructorTypeNode,
  ContinueStatement,
  Decorator,
  DeleteExpression,
  DoStatement,
  ElementAccessExpression,
  EnumDeclaration,
  EnumMember,
  ExportAssignment,
  ExportDeclaration,
  ExportSpecifier,
  ExpressionStatement,
  ExpressionWithTypeArguments,
  ExternalModuleReference,
  type FileReference,
  ForInOrOfStatement,
  ForStatement,
  FunctionDeclaration,
  FunctionExpression,
  FunctionTypeNode,
  GetAccessorDeclaration,
  HeritageClause,
  IfStatement,
  ImportAttribute,
  ImportAttributes,
  ImportClause,
  ImportDeclaration,
  ImportEqualsDeclaration,
  ImportSpecifier,
  ImportTypeNode,
  IndexSignatureDeclaration,
  IndexedAccessTypeNode,
  InferTypeNode,
  InterfaceDeclaration,
  IntersectionTypeNode,
  JSDoc,
  JSDocAugmentsTag,
  JSDocCallbackTag,
  JSDocDeprecatedTag,
  JSDocImplementsTag,
  JSDocImportTag,
  JSDocLink,
  JSDocLinkCode,
  JSDocLinkPlain,
  JSDocNameReference,
  JSDocNonNullableType,
  JSDocNullableType,
  JSDocOptionalType,
  JSDocOverloadTag,
  JSDocOverrideTag,
  JSDocParameterOrPropertyTag,
  JSDocPrivateTag,
  JSDocProtectedTag,
  JSDocPublicTag,
  JSDocReadonlyTag,
  JSDocReturnTag,
  JSDocSatisfiesTag,
  JSDocSeeTag,
  JSDocSignature,
  JSDocTemplateTag,
  JSDocText,
  JSDocThisTag,
  JSDocThrowsTag,
  JSDocTypeExpression,
  JSDocTypeLiteral,
  JSDocTypeTag,
  JSDocTypedefTag,
  JSDocUnknownTag,
  JSDocVariadicType,
  JsxAttribute,
  JsxAttributes,
  JsxClosingElement,
  JsxElement,
  JsxExpression,
  JsxFragment,
  JsxNamespacedName,
  JsxOpeningElement,
  JsxSelfClosingElement,
  JsxSpreadAttribute,
  JsxText,
  LabeledStatement,
  LiteralTypeNode,
  MappedTypeNode,
  MetaProperty,
  MethodDeclaration,
  MethodSignatureDeclaration,
  MissingDeclaration,
  type ModifierList,
  ModuleBlock,
  ModuleDeclaration,
  NamedExports,
  NamedImports,
  NamedTupleMember,
  NamespaceExport,
  NamespaceExportDeclaration,
  NamespaceImport,
  NewExpression,
  type Node,
  type NodeList,
  NodeVisitor,
  NoSubstitutionTemplateLiteral,
  NonNullExpression,
  NumericLiteral,
  ObjectLiteralExpression,
  OptionalTypeNode,
  ParameterDeclaration,
  ParenthesizedExpression,
  ParenthesizedTypeNode,
  PostfixUnaryExpression,
  PrefixUnaryExpression,
  PrivateIdentifier,
  PropertyAccessExpression,
  PropertyAssignment,
  PropertyDeclaration,
  PropertySignatureDeclaration,
  QualifiedName,
  RegularExpressionLiteral,
  RestTypeNode,
  ReturnStatement,
  SatisfiesExpression,
  SetAccessorDeclaration,
  ShorthandPropertyAssignment,
  SourceFile,
  SpreadAssignment,
  SpreadElement,
  StringLiteral,
  SwitchStatement,
  TaggedTemplateExpression,
  TemplateExpression,
  TemplateHead,
  TemplateLiteralTypeNode,
  TemplateLiteralTypeSpan,
  TemplateMiddle,
  TemplateSpan,
  TemplateTail,
  ThrowStatement,
  TryStatement,
  TupleTypeNode,
  TypeAliasDeclaration,
  TypeAssertion,
  TypeLiteralNode,
  TypeOfExpression,
  TypeOperatorNode,
  TypeParameterDeclaration,
  TypePredicateNode,
  TypeQueryNode,
  TypeReferenceNode,
  UnionTypeNode,
  VariableDeclaration,
  VariableDeclarationList,
  VariableStatement,
  VoidExpression,
  WhileStatement,
  WithStatement,
  YieldExpression,
  BigIntLiteral,
  Identifier,
} from './ast.js';
import { getJSDoc } from './parser.js';
import { SyntaxKind } from './syntax-kind.js';
import { hash128 } from './xxh3.js';
import { utf8Offsets } from './character-codes.js';

export const protocolVersion = 5;

const nodeSize = 28;
const headerSize = 44;
const nodeListKind = 0xffffffff;
const noStructuredData = 0xffffffff;

const dataTypeChildren = 0;
const dataTypeString = 1 << 30;
const dataTypeExtended = 2 << 30;

const utf8Encoder = new TextEncoder();

/** A growable little-endian byte buffer. */
class ByteWriter {
  bytes: Uint8Array;
  length: number;

  constructor(capacity: number) {
    this.bytes = new Uint8Array(capacity < 16 ? 16 : capacity);
    this.length = 0;
  }

  /** Makes room for `count` more bytes and returns the offset to write them at. */
  reserve(count: number): number {
    const at = this.length;
    const needed = at + count;
    if (needed > this.bytes.length) {
      let size = this.bytes.length * 2;
      while (size < needed) size *= 2;
      const grown = new Uint8Array(size);
      grown.set(this.bytes.subarray(0, at));
      this.bytes = grown;
    }
    this.length = needed;
    return at;
  }

  u8(value: number): void {
    const at = this.reserve(1);
    this.bytes[at] = value & 0xff;
  }

  u32(value: number): void {
    this.setU32(this.reserve(4), value);
  }

  setU32(at: number, value: number): void {
    const bytes = this.bytes;
    bytes[at] = value & 0xff;
    bytes[at + 1] = (value >>> 8) & 0xff;
    bytes[at + 2] = (value >>> 16) & 0xff;
    bytes[at + 3] = (value >>> 24) & 0xff;
  }

  /** Big-endian, for msgpack. */
  be(value: number, size: number): void {
    const at = this.reserve(size);
    for (let i = 0; i < size; i++) this.bytes[at + i] = (value >>> ((size - 1 - i) * 8)) & 0xff;
  }

  append(data: Uint8Array): void {
    const at = this.reserve(data.length);
    this.bytes.set(data, at);
  }

  /** Appends a node record. */
  node(kind: number, pos: number, end: number, parent: number, data: number, flags: number): void {
    const at = this.reserve(nodeSize);
    this.setU32(at, kind);
    this.setU32(at + 4, pos);
    this.setU32(at + 8, end);
    this.setU32(at + 12, 0);
    this.setU32(at + 16, parent);
    this.setU32(at + 20, data);
    this.setU32(at + 24, flags);
  }

  view(): Uint8Array {
    return this.bytes.subarray(0, this.length);
  }
}

function utf8Length(text: string): number {
  let length = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch < 0x80) length += 1;
    else if (ch < 0x800) length += 2;
    else if (ch >= 0xd800 && ch <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        length += 4;
        i++;
      } else length += 3;
    } else length += 3;
  }
  return length;
}

/** UTF-8 bytes of `text`, with lone surrogates as WTF-8 like tsgo's strings. */
function encodeUTF8(text: string): Uint8Array {
  const bytes = new Uint8Array(utf8Length(text));
  let at = 0;
  for (let i = 0; i < text.length; i++) {
    let ch = text.charCodeAt(i);
    if (ch < 0x80) {
      bytes[at++] = ch;
      continue;
    }
    if (ch < 0x800) {
      bytes[at++] = 0xc0 | (ch >> 6);
      bytes[at++] = 0x80 | (ch & 0x3f);
      continue;
    }
    if (ch >= 0xd800 && ch <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        ch = (ch - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
        i++;
        bytes[at++] = 0xf0 | (ch >> 18);
        bytes[at++] = 0x80 | ((ch >> 12) & 0x3f);
        bytes[at++] = 0x80 | ((ch >> 6) & 0x3f);
        bytes[at++] = 0x80 | (ch & 0x3f);
        continue;
      }
    }
    bytes[at++] = 0xe0 | (ch >> 12);
    bytes[at++] = 0x80 | ((ch >> 6) & 0x3f);
    bytes[at++] = 0x80 | (ch & 0x3f);
  }
  return bytes;
}

function isASCII(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) >= 0x80) return false;
  return true;
}

/**
 * Strings referenced by nodes. A string that equals the file text just before the node's
 * end (less a closing quote) is stored as that slice; others are appended after the text.
 */
class StringTable {
  readonly fileText: Uint8Array;
  readonly asciiFile: boolean;
  readonly offsets8: Int32Array | undefined;
  readonly offsets: ByteWriter;
  readonly others: ByteWriter;
  count: number;

  constructor(text: string, fileText: Uint8Array) {
    this.fileText = fileText;
    this.asciiFile = fileText.length === text.length;
    this.offsets8 = this.asciiFile ? undefined : utf8Offsets(text);
    this.offsets = new ByteWriter(1024);
    this.others = new ByteWriter(64);
    this.count = 0;
  }

  /** The UTF-8 offset of UTF-16 offset `pos`. */
  utf8(pos: number): number {
    const offsets = this.offsets8;
    if (offsets === undefined || pos < 0 || pos >= offsets.length) return pos;
    return offsets[pos];
  }

  private push(start: number, end: number): number {
    const index = this.count;
    this.offsets.u32(start);
    this.offsets.u32(end);
    this.count += 2;
    return index;
  }

  /** Records the whole file text. */
  addFileText(pos: number, end: number): number {
    return this.push(this.utf8(pos), this.utf8(end));
  }

  add(text: string, kind: SyntaxKind, pos: number, end: number): number {
    const fileText = this.fileText;
    const ascii = isASCII(text);
    const length = ascii ? text.length : utf8Length(text);
    const pos8 = this.utf8(pos);
    let end8 = this.utf8(end);
    if (end8 - pos8 > 0 && end8 <= fileText.length) {
      if (
        kind === SyntaxKind.StringLiteral ||
        kind === SyntaxKind.TemplateTail ||
        kind === SyntaxKind.NoSubstitutionTemplateLiteral
      )
        end8 -= 1;
      const start8 = end8 - length;
      if (start8 >= 0 && this.matches(text, ascii, start8, end8)) return this.push(start8, end8);
    }
    const offset = fileText.length + this.others.length;
    if (ascii) {
      const at = this.others.reserve(length);
      const bytes = this.others.bytes;
      for (let i = 0; i < length; i++) bytes[at + i] = text.charCodeAt(i);
    } else this.others.append(encodeUTF8(text));
    return this.push(offset, offset + length);
  }

  private matches(text: string, ascii: boolean, start8: number, end8: number): boolean {
    const fileText = this.fileText;
    if (ascii) {
      for (let i = 0; i < text.length; i++) if (fileText[start8 + i] !== text.charCodeAt(i)) return false;
      return true;
    }
    const encoded = encodeUTF8(text);
    if (encoded.length !== end8 - start8) return false;
    for (let i = 0; i < encoded.length; i++) if (fileText[start8 + i] !== encoded[i]) return false;
    return true;
  }
}

function hasModifiers(modifiers: ModifierList | undefined): boolean {
  return modifiers !== undefined && modifiers.nodes.length > 0;
}

/** Which of a node's child properties are present, one bit per property in visit order. */
function hasElements(nodes: readonly Node[] | undefined): boolean {
  return nodes !== undefined && nodes.length > 0;
}

function childrenPropertyMask(node: Node): number {
  switch (node.kind) {
    case SyntaxKind.QualifiedName:
      return node instanceof QualifiedName ? (node.left !== undefined ? 1 : 0) | (node.right !== undefined ? 2 : 0) : 0;
    case SyntaxKind.ComputedPropertyName:
      return node instanceof ComputedPropertyName ? (node.expression !== undefined ? 1 : 0) : 0;
    case SyntaxKind.Decorator:
      return node instanceof Decorator ? (node.expression !== undefined ? 1 : 0) : 0;
    case SyntaxKind.IfStatement:
      return node instanceof IfStatement
        ? (node.expression !== undefined ? 1 : 0) |
            (node.thenStatement !== undefined ? 2 : 0) |
            (node.elseStatement !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.DoStatement:
      return node instanceof DoStatement
        ? (node.statement !== undefined ? 1 : 0) | (node.expression !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.WhileStatement:
      return node instanceof WhileStatement
        ? (node.expression !== undefined ? 1 : 0) | (node.statement !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.ForStatement:
      return node instanceof ForStatement
        ? (node.initializer !== undefined ? 1 : 0) |
            (node.condition !== undefined ? 2 : 0) |
            (node.incrementor !== undefined ? 4 : 0) |
            (node.statement !== undefined ? 8 : 0)
        : 0;
    case SyntaxKind.ForInStatement:
    case SyntaxKind.ForOfStatement:
      return node instanceof ForInOrOfStatement
        ? (node.awaitModifier !== undefined ? 1 : 0) |
            (node.initializer !== undefined ? 2 : 0) |
            (node.expression !== undefined ? 4 : 0) |
            (node.statement !== undefined ? 8 : 0)
        : 0;
    case SyntaxKind.BreakStatement:
      return node instanceof BreakStatement ? (node.label !== undefined ? 1 : 0) : 0;
    case SyntaxKind.ContinueStatement:
      return node instanceof ContinueStatement ? (node.label !== undefined ? 1 : 0) : 0;
    case SyntaxKind.ReturnStatement:
      return node instanceof ReturnStatement ? (node.expression !== undefined ? 1 : 0) : 0;
    case SyntaxKind.WithStatement:
      return node instanceof WithStatement
        ? (node.expression !== undefined ? 1 : 0) | (node.statement !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.SwitchStatement:
      return node instanceof SwitchStatement
        ? (node.expression !== undefined ? 1 : 0) | (node.caseBlock !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.CaseBlock:
      return node instanceof CaseBlock ? (node.clauses !== undefined ? 1 : 0) : 0;
    case SyntaxKind.CaseClause:
    case SyntaxKind.DefaultClause:
      return node instanceof CaseOrDefaultClause
        ? (node.expression !== undefined ? 1 : 0) | (node.statements !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.ThrowStatement:
      return node instanceof ThrowStatement ? (node.expression !== undefined ? 1 : 0) : 0;
    case SyntaxKind.TryStatement:
      return node instanceof TryStatement
        ? (node.tryBlock !== undefined ? 1 : 0) |
            (node.catchClause !== undefined ? 2 : 0) |
            (node.finallyBlock !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.CatchClause:
      return node instanceof CatchClause
        ? (node.variableDeclaration !== undefined ? 1 : 0) | (node.block !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.LabeledStatement:
      return node instanceof LabeledStatement
        ? (node.label !== undefined ? 1 : 0) | (node.statement !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.ExpressionStatement:
      return node instanceof ExpressionStatement ? (node.expression !== undefined ? 1 : 0) : 0;
    case SyntaxKind.Block:
      return node instanceof Block ? (node.statements !== undefined ? 1 : 0) : 0;
    case SyntaxKind.VariableStatement:
      return node instanceof VariableStatement
        ? (hasModifiers(node.modifiers) ? 1 : 0) | (node.declarationList !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.VariableDeclaration:
      return node instanceof VariableDeclaration
        ? (node.name !== undefined ? 1 : 0) |
            (node.exclamationToken !== undefined ? 2 : 0) |
            (node.type !== undefined ? 4 : 0) |
            (node.initializer !== undefined ? 8 : 0)
        : 0;
    case SyntaxKind.VariableDeclarationList:
      return node instanceof VariableDeclarationList ? (node.declarations !== undefined ? 1 : 0) : 0;
    case SyntaxKind.ObjectBindingPattern:
    case SyntaxKind.ArrayBindingPattern:
      return node instanceof BindingPattern ? (node.elements !== undefined ? 1 : 0) : 0;
    case SyntaxKind.Parameter:
      return node instanceof ParameterDeclaration
        ? (hasModifiers(node.modifiers) ? 1 : 0) |
            (node.dotDotDotToken !== undefined ? 2 : 0) |
            (node.name !== undefined ? 4 : 0) |
            (node.questionToken !== undefined ? 8 : 0) |
            (node.type !== undefined ? 16 : 0) |
            (node.initializer !== undefined ? 32 : 0)
        : 0;
    case SyntaxKind.BindingElement:
      return node instanceof BindingElement
        ? (node.dotDotDotToken !== undefined ? 1 : 0) |
            (node.propertyName !== undefined ? 2 : 0) |
            (node.name !== undefined ? 4 : 0) |
            (node.initializer !== undefined ? 8 : 0)
        : 0;
    case SyntaxKind.MissingDeclaration:
      return node instanceof MissingDeclaration ? (hasModifiers(node.modifiers) ? 1 : 0) : 0;
    case SyntaxKind.FunctionDeclaration:
      return node instanceof FunctionDeclaration
        ? (hasModifiers(node.modifiers) ? 1 : 0) |
            (node.asteriskToken !== undefined ? 2 : 0) |
            (node.name !== undefined ? 4 : 0) |
            (node.typeParameters !== undefined ? 8 : 0) |
            (node.parameters !== undefined ? 16 : 0) |
            (node.type !== undefined ? 32 : 0) |
            (node.body !== undefined ? 64 : 0)
        : 0;
    case SyntaxKind.ClassDeclaration:
      return node instanceof ClassDeclaration
        ? (hasModifiers(node.modifiers) ? 1 : 0) |
            (node.name !== undefined ? 2 : 0) |
            (node.typeParameters !== undefined ? 4 : 0) |
            (node.heritageClauses !== undefined ? 8 : 0) |
            (node.members !== undefined ? 16 : 0)
        : 0;
    case SyntaxKind.ClassExpression:
      return node instanceof ClassExpression
        ? (hasModifiers(node.modifiers) ? 1 : 0) |
            (node.name !== undefined ? 2 : 0) |
            (node.typeParameters !== undefined ? 4 : 0) |
            (node.heritageClauses !== undefined ? 8 : 0) |
            (node.members !== undefined ? 16 : 0)
        : 0;
    case SyntaxKind.HeritageClause:
      return node instanceof HeritageClause ? (node.types !== undefined ? 1 : 0) : 0;
    case SyntaxKind.InterfaceDeclaration:
      return node instanceof InterfaceDeclaration
        ? (hasModifiers(node.modifiers) ? 1 : 0) |
            (node.name !== undefined ? 2 : 0) |
            (node.typeParameters !== undefined ? 4 : 0) |
            (node.heritageClauses !== undefined ? 8 : 0) |
            (node.members !== undefined ? 16 : 0)
        : 0;
    case SyntaxKind.TypeAliasDeclaration:
    case SyntaxKind.JSTypeAliasDeclaration:
      return node instanceof TypeAliasDeclaration
        ? (hasModifiers(node.modifiers) ? 1 : 0) |
            (node.name !== undefined ? 2 : 0) |
            (node.typeParameters !== undefined ? 4 : 0) |
            (node.type !== undefined ? 8 : 0)
        : 0;
    case SyntaxKind.EnumMember:
      return node instanceof EnumMember
        ? (node.name !== undefined ? 1 : 0) | (node.initializer !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.EnumDeclaration:
      return node instanceof EnumDeclaration
        ? (hasModifiers(node.modifiers) ? 1 : 0) |
            (node.name !== undefined ? 2 : 0) |
            (node.members !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.ModuleBlock:
      return node instanceof ModuleBlock ? (node.statements !== undefined ? 1 : 0) : 0;
    case SyntaxKind.ImportDeclaration:
    case SyntaxKind.JSImportDeclaration:
      return node instanceof ImportDeclaration
        ? (hasModifiers(node.modifiers) ? 1 : 0) |
            (node.importClause !== undefined ? 2 : 0) |
            (node.moduleSpecifier !== undefined ? 4 : 0) |
            (node.attributes !== undefined ? 8 : 0)
        : 0;
    case SyntaxKind.ExternalModuleReference:
      return node instanceof ExternalModuleReference ? (node.expression !== undefined ? 1 : 0) : 0;
    case SyntaxKind.NamespaceImport:
      return node instanceof NamespaceImport ? (node.name !== undefined ? 1 : 0) : 0;
    case SyntaxKind.NamedImports:
      return node instanceof NamedImports ? (node.elements !== undefined ? 1 : 0) : 0;
    case SyntaxKind.ExportAssignment:
      return node instanceof ExportAssignment
        ? (hasModifiers(node.modifiers) ? 1 : 0) |
            (node.type !== undefined ? 2 : 0) |
            (node.expression !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.NamespaceExportDeclaration:
      return node instanceof NamespaceExportDeclaration
        ? (hasModifiers(node.modifiers) ? 1 : 0) | (node.name !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.NamespaceExport:
      return node instanceof NamespaceExport ? (node.name !== undefined ? 1 : 0) : 0;
    case SyntaxKind.NamedExports:
      return node instanceof NamedExports ? (node.elements !== undefined ? 1 : 0) : 0;
    case SyntaxKind.ExportSpecifier:
      return node instanceof ExportSpecifier
        ? (node.propertyName !== undefined ? 1 : 0) | (node.name !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.CallSignature:
      return node instanceof CallSignatureDeclaration
        ? (node.typeParameters !== undefined ? 1 : 0) |
            (node.parameters !== undefined ? 2 : 0) |
            (node.type !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.ConstructSignature:
      return node instanceof ConstructSignatureDeclaration
        ? (node.typeParameters !== undefined ? 1 : 0) |
            (node.parameters !== undefined ? 2 : 0) |
            (node.type !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.Constructor:
      return node instanceof ConstructorDeclaration
        ? (hasModifiers(node.modifiers) ? 1 : 0) |
            (node.typeParameters !== undefined ? 2 : 0) |
            (node.parameters !== undefined ? 4 : 0) |
            (node.type !== undefined ? 8 : 0) |
            (node.body !== undefined ? 16 : 0)
        : 0;
    case SyntaxKind.GetAccessor:
      return node instanceof GetAccessorDeclaration
        ? (hasModifiers(node.modifiers) ? 1 : 0) |
            (node.name !== undefined ? 2 : 0) |
            (node.typeParameters !== undefined ? 4 : 0) |
            (node.parameters !== undefined ? 8 : 0) |
            (node.type !== undefined ? 16 : 0) |
            (node.body !== undefined ? 32 : 0)
        : 0;
    case SyntaxKind.SetAccessor:
      return node instanceof SetAccessorDeclaration
        ? (hasModifiers(node.modifiers) ? 1 : 0) |
            (node.name !== undefined ? 2 : 0) |
            (node.typeParameters !== undefined ? 4 : 0) |
            (node.parameters !== undefined ? 8 : 0) |
            (node.type !== undefined ? 16 : 0) |
            (node.body !== undefined ? 32 : 0)
        : 0;
    case SyntaxKind.IndexSignature:
      return node instanceof IndexSignatureDeclaration
        ? (hasModifiers(node.modifiers) ? 1 : 0) |
            (node.parameters !== undefined ? 2 : 0) |
            (node.type !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.MethodSignature:
      return node instanceof MethodSignatureDeclaration
        ? (hasModifiers(node.modifiers) ? 1 : 0) |
            (node.name !== undefined ? 2 : 0) |
            (node.postfixToken !== undefined ? 4 : 0) |
            (node.typeParameters !== undefined ? 8 : 0) |
            (node.parameters !== undefined ? 16 : 0) |
            (node.type !== undefined ? 32 : 0)
        : 0;
    case SyntaxKind.MethodDeclaration:
      return node instanceof MethodDeclaration
        ? (hasModifiers(node.modifiers) ? 1 : 0) |
            (node.asteriskToken !== undefined ? 2 : 0) |
            (node.name !== undefined ? 4 : 0) |
            (node.postfixToken !== undefined ? 8 : 0) |
            (node.typeParameters !== undefined ? 16 : 0) |
            (node.parameters !== undefined ? 32 : 0) |
            (node.type !== undefined ? 64 : 0) |
            (node.body !== undefined ? 128 : 0)
        : 0;
    case SyntaxKind.PropertySignature:
      return node instanceof PropertySignatureDeclaration
        ? (hasModifiers(node.modifiers) ? 1 : 0) |
            (node.name !== undefined ? 2 : 0) |
            (node.postfixToken !== undefined ? 4 : 0) |
            (node.type !== undefined ? 8 : 0) |
            (node.initializer !== undefined ? 16 : 0)
        : 0;
    case SyntaxKind.PropertyDeclaration:
      return node instanceof PropertyDeclaration
        ? (hasModifiers(node.modifiers) ? 1 : 0) |
            (node.name !== undefined ? 2 : 0) |
            (node.postfixToken !== undefined ? 4 : 0) |
            (node.type !== undefined ? 8 : 0) |
            (node.initializer !== undefined ? 16 : 0)
        : 0;
    case SyntaxKind.ClassStaticBlockDeclaration:
      return node instanceof ClassStaticBlockDeclaration
        ? (hasModifiers(node.modifiers) ? 1 : 0) | (node.body !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.BinaryExpression:
      return node instanceof BinaryExpression
        ? (hasModifiers(node.modifiers) ? 1 : 0) |
            (node.left !== undefined ? 2 : 0) |
            (node.type !== undefined ? 4 : 0) |
            (node.operatorToken !== undefined ? 8 : 0) |
            (node.right !== undefined ? 16 : 0)
        : 0;
    case SyntaxKind.PrefixUnaryExpression:
      return node instanceof PrefixUnaryExpression ? (node.operand !== undefined ? 1 : 0) : 0;
    case SyntaxKind.PostfixUnaryExpression:
      return node instanceof PostfixUnaryExpression ? (node.operand !== undefined ? 1 : 0) : 0;
    case SyntaxKind.YieldExpression:
      return node instanceof YieldExpression
        ? (node.asteriskToken !== undefined ? 1 : 0) | (node.expression !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.ArrowFunction:
      return node instanceof ArrowFunction
        ? (hasModifiers(node.modifiers) ? 1 : 0) |
            (node.typeParameters !== undefined ? 2 : 0) |
            (node.parameters !== undefined ? 4 : 0) |
            (node.type !== undefined ? 8 : 0) |
            (node.equalsGreaterThanToken !== undefined ? 16 : 0) |
            (node.body !== undefined ? 32 : 0)
        : 0;
    case SyntaxKind.FunctionExpression:
      return node instanceof FunctionExpression
        ? (hasModifiers(node.modifiers) ? 1 : 0) |
            (node.asteriskToken !== undefined ? 2 : 0) |
            (node.name !== undefined ? 4 : 0) |
            (node.typeParameters !== undefined ? 8 : 0) |
            (node.parameters !== undefined ? 16 : 0) |
            (node.type !== undefined ? 32 : 0) |
            (node.body !== undefined ? 64 : 0)
        : 0;
    case SyntaxKind.AsExpression:
      return node instanceof AsExpression
        ? (node.expression !== undefined ? 1 : 0) | (node.type !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.SatisfiesExpression:
      return node instanceof SatisfiesExpression
        ? (node.expression !== undefined ? 1 : 0) | (node.type !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.ConditionalExpression:
      return node instanceof ConditionalExpression
        ? (node.condition !== undefined ? 1 : 0) |
            (node.questionToken !== undefined ? 2 : 0) |
            (node.whenTrue !== undefined ? 4 : 0) |
            (node.colonToken !== undefined ? 8 : 0) |
            (node.whenFalse !== undefined ? 16 : 0)
        : 0;
    case SyntaxKind.PropertyAccessExpression:
      return node instanceof PropertyAccessExpression
        ? (node.expression !== undefined ? 1 : 0) |
            (node.questionDotToken !== undefined ? 2 : 0) |
            (node.name !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.ElementAccessExpression:
      return node instanceof ElementAccessExpression
        ? (node.expression !== undefined ? 1 : 0) |
            (node.questionDotToken !== undefined ? 2 : 0) |
            (node.argumentExpression !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.CallExpression:
      return node instanceof CallExpression
        ? (node.expression !== undefined ? 1 : 0) |
            (node.questionDotToken !== undefined ? 2 : 0) |
            (node.typeArguments !== undefined ? 4 : 0) |
            (node.arguments !== undefined ? 8 : 0)
        : 0;
    case SyntaxKind.NewExpression:
      return node instanceof NewExpression
        ? (node.expression !== undefined ? 1 : 0) |
            (node.typeArguments !== undefined ? 2 : 0) |
            (node.arguments !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.MetaProperty:
      return node instanceof MetaProperty ? (node.name !== undefined ? 1 : 0) : 0;
    case SyntaxKind.NonNullExpression:
      return node instanceof NonNullExpression ? (node.expression !== undefined ? 1 : 0) : 0;
    case SyntaxKind.SpreadElement:
      return node instanceof SpreadElement ? (node.expression !== undefined ? 1 : 0) : 0;
    case SyntaxKind.TemplateExpression:
      return node instanceof TemplateExpression
        ? (node.head !== undefined ? 1 : 0) | (node.templateSpans !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.TemplateSpan:
      return node instanceof TemplateSpan
        ? (node.expression !== undefined ? 1 : 0) | (node.literal !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.TaggedTemplateExpression:
      return node instanceof TaggedTemplateExpression
        ? (node.tag !== undefined ? 1 : 0) |
            (node.questionDotToken !== undefined ? 2 : 0) |
            (node.typeArguments !== undefined ? 4 : 0) |
            (node.template !== undefined ? 8 : 0)
        : 0;
    case SyntaxKind.ParenthesizedExpression:
      return node instanceof ParenthesizedExpression ? (node.expression !== undefined ? 1 : 0) : 0;
    case SyntaxKind.ArrayLiteralExpression:
      return node instanceof ArrayLiteralExpression ? (node.elements !== undefined ? 1 : 0) : 0;
    case SyntaxKind.ObjectLiteralExpression:
      return node instanceof ObjectLiteralExpression ? (node.properties !== undefined ? 1 : 0) : 0;
    case SyntaxKind.SpreadAssignment:
      return node instanceof SpreadAssignment ? (node.expression !== undefined ? 1 : 0) : 0;
    case SyntaxKind.PropertyAssignment:
      return node instanceof PropertyAssignment
        ? (hasModifiers(node.modifiers) ? 1 : 0) |
            (node.name !== undefined ? 2 : 0) |
            (node.postfixToken !== undefined ? 4 : 0) |
            (node.type !== undefined ? 8 : 0) |
            (node.initializer !== undefined ? 16 : 0)
        : 0;
    case SyntaxKind.ShorthandPropertyAssignment:
      return node instanceof ShorthandPropertyAssignment
        ? (hasModifiers(node.modifiers) ? 1 : 0) |
            (node.name !== undefined ? 2 : 0) |
            (node.postfixToken !== undefined ? 4 : 0) |
            (node.type !== undefined ? 8 : 0) |
            (node.equalsToken !== undefined ? 16 : 0) |
            (node.objectAssignmentInitializer !== undefined ? 32 : 0)
        : 0;
    case SyntaxKind.DeleteExpression:
      return node instanceof DeleteExpression ? (node.expression !== undefined ? 1 : 0) : 0;
    case SyntaxKind.TypeOfExpression:
      return node instanceof TypeOfExpression ? (node.expression !== undefined ? 1 : 0) : 0;
    case SyntaxKind.VoidExpression:
      return node instanceof VoidExpression ? (node.expression !== undefined ? 1 : 0) : 0;
    case SyntaxKind.AwaitExpression:
      return node instanceof AwaitExpression ? (node.expression !== undefined ? 1 : 0) : 0;
    case SyntaxKind.TypeAssertionExpression:
      return node instanceof TypeAssertion
        ? (node.type !== undefined ? 1 : 0) | (node.expression !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.UnionType:
      return node instanceof UnionTypeNode ? (node.types !== undefined ? 1 : 0) : 0;
    case SyntaxKind.IntersectionType:
      return node instanceof IntersectionTypeNode ? (node.types !== undefined ? 1 : 0) : 0;
    case SyntaxKind.ConditionalType:
      return node instanceof ConditionalTypeNode
        ? (node.checkType !== undefined ? 1 : 0) |
            (node.extendsType !== undefined ? 2 : 0) |
            (node.trueType !== undefined ? 4 : 0) |
            (node.falseType !== undefined ? 8 : 0)
        : 0;
    case SyntaxKind.TypeOperator:
      return node instanceof TypeOperatorNode ? (node.type !== undefined ? 1 : 0) : 0;
    case SyntaxKind.InferType:
      return node instanceof InferTypeNode ? (node.typeParameter !== undefined ? 1 : 0) : 0;
    case SyntaxKind.ArrayType:
      return node instanceof ArrayTypeNode ? (node.elementType !== undefined ? 1 : 0) : 0;
    case SyntaxKind.IndexedAccessType:
      return node instanceof IndexedAccessTypeNode
        ? (node.objectType !== undefined ? 1 : 0) | (node.indexType !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.TypeReference:
      return node instanceof TypeReferenceNode
        ? (node.typeName !== undefined ? 1 : 0) | (node.typeArguments !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.ExpressionWithTypeArguments:
      return node instanceof ExpressionWithTypeArguments
        ? (node.expression !== undefined ? 1 : 0) | (node.typeArguments !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.LiteralType:
      return node instanceof LiteralTypeNode ? (node.literal !== undefined ? 1 : 0) : 0;
    case SyntaxKind.TypePredicate:
      return node instanceof TypePredicateNode
        ? (node.assertsModifier !== undefined ? 1 : 0) |
            (node.parameterName !== undefined ? 2 : 0) |
            (node.type !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.ImportAttribute:
      return node instanceof ImportAttribute
        ? (node.name !== undefined ? 1 : 0) | (node.value !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.ImportAttributes:
      return node instanceof ImportAttributes ? (node.attributes !== undefined ? 1 : 0) : 0;
    case SyntaxKind.TypeQuery:
      return node instanceof TypeQueryNode
        ? (node.exprName !== undefined ? 1 : 0) | (node.typeArguments !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.MappedType:
      return node instanceof MappedTypeNode
        ? (node.readonlyToken !== undefined ? 1 : 0) |
            (node.typeParameter !== undefined ? 2 : 0) |
            (node.nameType !== undefined ? 4 : 0) |
            (node.questionToken !== undefined ? 8 : 0) |
            (node.type !== undefined ? 16 : 0) |
            (node.members !== undefined ? 32 : 0)
        : 0;
    case SyntaxKind.TypeLiteral:
      return node instanceof TypeLiteralNode ? (node.members !== undefined ? 1 : 0) : 0;
    case SyntaxKind.TupleType:
      return node instanceof TupleTypeNode ? (node.elements !== undefined ? 1 : 0) : 0;
    case SyntaxKind.NamedTupleMember:
      return node instanceof NamedTupleMember
        ? (node.dotDotDotToken !== undefined ? 1 : 0) |
            (node.name !== undefined ? 2 : 0) |
            (node.questionToken !== undefined ? 4 : 0) |
            (node.type !== undefined ? 8 : 0)
        : 0;
    case SyntaxKind.OptionalType:
      return node instanceof OptionalTypeNode ? (node.type !== undefined ? 1 : 0) : 0;
    case SyntaxKind.RestType:
      return node instanceof RestTypeNode ? (node.type !== undefined ? 1 : 0) : 0;
    case SyntaxKind.ParenthesizedType:
      return node instanceof ParenthesizedTypeNode ? (node.type !== undefined ? 1 : 0) : 0;
    case SyntaxKind.FunctionType:
      return node instanceof FunctionTypeNode
        ? (node.typeParameters !== undefined ? 1 : 0) |
            (node.parameters !== undefined ? 2 : 0) |
            (node.type !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.ConstructorType:
      return node instanceof ConstructorTypeNode
        ? (hasModifiers(node.modifiers) ? 1 : 0) |
            (node.typeParameters !== undefined ? 2 : 0) |
            (node.parameters !== undefined ? 4 : 0) |
            (node.type !== undefined ? 8 : 0)
        : 0;
    case SyntaxKind.TemplateLiteralType:
      return node instanceof TemplateLiteralTypeNode
        ? (node.head !== undefined ? 1 : 0) | (node.templateSpans !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.TemplateLiteralTypeSpan:
      return node instanceof TemplateLiteralTypeSpan
        ? (node.type !== undefined ? 1 : 0) | (node.literal !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.JsxElement:
      return node instanceof JsxElement
        ? (node.openingElement !== undefined ? 1 : 0) |
            (node.children !== undefined ? 2 : 0) |
            (node.closingElement !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.JsxAttributes:
      return node instanceof JsxAttributes ? (node.properties !== undefined ? 1 : 0) : 0;
    case SyntaxKind.JsxNamespacedName:
      return node instanceof JsxNamespacedName
        ? (node.namespace !== undefined ? 1 : 0) | (node.name !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.JsxOpeningElement:
      return node instanceof JsxOpeningElement
        ? (node.tagName !== undefined ? 1 : 0) |
            (node.typeArguments !== undefined ? 2 : 0) |
            (node.attributes !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.JsxSelfClosingElement:
      return node instanceof JsxSelfClosingElement
        ? (node.tagName !== undefined ? 1 : 0) |
            (node.typeArguments !== undefined ? 2 : 0) |
            (node.attributes !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.JsxFragment:
      return node instanceof JsxFragment
        ? (node.openingFragment !== undefined ? 1 : 0) |
            (node.children !== undefined ? 2 : 0) |
            (node.closingFragment !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.JsxAttribute:
      return node instanceof JsxAttribute
        ? (node.name !== undefined ? 1 : 0) | (node.initializer !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.JsxSpreadAttribute:
      return node instanceof JsxSpreadAttribute ? (node.expression !== undefined ? 1 : 0) : 0;
    case SyntaxKind.JsxClosingElement:
      return node instanceof JsxClosingElement ? (node.tagName !== undefined ? 1 : 0) : 0;
    case SyntaxKind.JsxExpression:
      return node instanceof JsxExpression
        ? (node.dotDotDotToken !== undefined ? 1 : 0) | (node.expression !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.JSDoc:
      return node instanceof JSDoc ? (node.comment !== undefined ? 1 : 0) | (node.tags !== undefined ? 2 : 0) : 0;
    case SyntaxKind.JSDocTypeExpression:
      return node instanceof JSDocTypeExpression ? (node.type !== undefined ? 1 : 0) : 0;
    case SyntaxKind.JSDocNonNullableType:
      return node instanceof JSDocNonNullableType ? (node.type !== undefined ? 1 : 0) : 0;
    case SyntaxKind.JSDocNullableType:
      return node instanceof JSDocNullableType ? (node.type !== undefined ? 1 : 0) : 0;
    case SyntaxKind.JSDocVariadicType:
      return node instanceof JSDocVariadicType ? (node.type !== undefined ? 1 : 0) : 0;
    case SyntaxKind.JSDocOptionalType:
      return node instanceof JSDocOptionalType ? (node.type !== undefined ? 1 : 0) : 0;
    case SyntaxKind.JSDocTypeTag:
      return node instanceof JSDocTypeTag
        ? (node.tagName !== undefined ? 1 : 0) |
            (node.typeExpression !== undefined ? 2 : 0) |
            (node.comment !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.JSDocUnknownTag:
      return node instanceof JSDocUnknownTag
        ? (node.tagName !== undefined ? 1 : 0) | (node.comment !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.JSDocTemplateTag:
      return node instanceof JSDocTemplateTag
        ? (node.tagName !== undefined ? 1 : 0) |
            (node.constraint !== undefined ? 2 : 0) |
            (node.typeParameters !== undefined ? 4 : 0) |
            (node.comment !== undefined ? 8 : 0)
        : 0;
    case SyntaxKind.JSDocReturnTag:
      return node instanceof JSDocReturnTag
        ? (node.tagName !== undefined ? 1 : 0) |
            (node.typeExpression !== undefined ? 2 : 0) |
            (node.comment !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.JSDocPublicTag:
      return node instanceof JSDocPublicTag
        ? (node.tagName !== undefined ? 1 : 0) | (node.comment !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.JSDocPrivateTag:
      return node instanceof JSDocPrivateTag
        ? (node.tagName !== undefined ? 1 : 0) | (node.comment !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.JSDocProtectedTag:
      return node instanceof JSDocProtectedTag
        ? (node.tagName !== undefined ? 1 : 0) | (node.comment !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.JSDocReadonlyTag:
      return node instanceof JSDocReadonlyTag
        ? (node.tagName !== undefined ? 1 : 0) | (node.comment !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.JSDocOverrideTag:
      return node instanceof JSDocOverrideTag
        ? (node.tagName !== undefined ? 1 : 0) | (node.comment !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.JSDocDeprecatedTag:
      return node instanceof JSDocDeprecatedTag
        ? (node.tagName !== undefined ? 1 : 0) | (node.comment !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.JSDocSeeTag:
      return node instanceof JSDocSeeTag
        ? (node.tagName !== undefined ? 1 : 0) |
            (node.nameExpression !== undefined ? 2 : 0) |
            (node.comment !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.JSDocImplementsTag:
      return node instanceof JSDocImplementsTag
        ? (node.tagName !== undefined ? 1 : 0) |
            (node.className !== undefined ? 2 : 0) |
            (node.comment !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.JSDocAugmentsTag:
      return node instanceof JSDocAugmentsTag
        ? (node.tagName !== undefined ? 1 : 0) |
            (node.className !== undefined ? 2 : 0) |
            (node.comment !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.JSDocSatisfiesTag:
      return node instanceof JSDocSatisfiesTag
        ? (node.tagName !== undefined ? 1 : 0) |
            (node.typeExpression !== undefined ? 2 : 0) |
            (node.comment !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.JSDocThrowsTag:
      return node instanceof JSDocThrowsTag
        ? (node.tagName !== undefined ? 1 : 0) |
            (node.typeExpression !== undefined ? 2 : 0) |
            (node.comment !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.JSDocThisTag:
      return node instanceof JSDocThisTag
        ? (node.tagName !== undefined ? 1 : 0) |
            (node.typeExpression !== undefined ? 2 : 0) |
            (node.comment !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.JSDocImportTag:
      return node instanceof JSDocImportTag
        ? (node.tagName !== undefined ? 1 : 0) |
            (node.importClause !== undefined ? 2 : 0) |
            (node.moduleSpecifier !== undefined ? 4 : 0) |
            (node.attributes !== undefined ? 8 : 0) |
            (node.comment !== undefined ? 16 : 0)
        : 0;
    case SyntaxKind.JSDocCallbackTag:
      return node instanceof JSDocCallbackTag
        ? (node.tagName !== undefined ? 1 : 0) |
            (node.typeExpression !== undefined ? 2 : 0) |
            (node.name !== undefined ? 4 : 0) |
            (node.comment !== undefined ? 8 : 0)
        : 0;
    case SyntaxKind.JSDocOverloadTag:
      return node instanceof JSDocOverloadTag
        ? (node.tagName !== undefined ? 1 : 0) |
            (node.typeExpression !== undefined ? 2 : 0) |
            (node.comment !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.JSDocTypedefTag:
      return node instanceof JSDocTypedefTag
        ? (node.tagName !== undefined ? 1 : 0) |
            (node.typeExpression !== undefined ? 2 : 0) |
            (node.name !== undefined ? 4 : 0) |
            (node.comment !== undefined ? 8 : 0)
        : 0;
    case SyntaxKind.JSDocSignature:
      return node instanceof JSDocSignature
        ? (node.typeParameters !== undefined ? 1 : 0) |
            (node.parameters !== undefined ? 2 : 0) |
            (node.type !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.JSDocNameReference:
      return node instanceof JSDocNameReference ? (node.name !== undefined ? 1 : 0) : 0;
    case SyntaxKind.ModuleDeclaration:
      return node instanceof ModuleDeclaration
        ? (hasModifiers(node.modifiers) ? 1 : 0) | (node.name !== undefined ? 2 : 0) | (node.body !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.ImportEqualsDeclaration:
      return node instanceof ImportEqualsDeclaration
        ? (hasModifiers(node.modifiers) ? 1 : 0) |
            (node.name !== undefined ? 2 : 0) |
            (node.moduleReference !== undefined ? 4 : 0)
        : 0;
    case SyntaxKind.ExportDeclaration:
      return node instanceof ExportDeclaration
        ? (hasModifiers(node.modifiers) ? 1 : 0) |
            (node.exportClause !== undefined ? 2 : 0) |
            (node.moduleSpecifier !== undefined ? 4 : 0) |
            (node.attributes !== undefined ? 8 : 0)
        : 0;
    case SyntaxKind.ImportType:
      return node instanceof ImportTypeNode
        ? (node.argument !== undefined ? 1 : 0) |
            (node.attributes !== undefined ? 2 : 0) |
            (node.qualifier !== undefined ? 4 : 0) |
            (node.typeArguments !== undefined ? 8 : 0)
        : 0;
    case SyntaxKind.ImportClause:
      return node instanceof ImportClause
        ? (node.name !== undefined ? 1 : 0) | (node.namedBindings !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.ImportSpecifier:
      return node instanceof ImportSpecifier
        ? (node.propertyName !== undefined ? 1 : 0) | (node.name !== undefined ? 2 : 0)
        : 0;
    case SyntaxKind.JSDocLink:
      return node instanceof JSDocLink ? (node.name !== undefined ? 1 : 0) : 0;
    case SyntaxKind.JSDocLinkPlain:
      return node instanceof JSDocLinkPlain ? (node.name !== undefined ? 1 : 0) : 0;
    case SyntaxKind.JSDocLinkCode:
      return node instanceof JSDocLinkCode ? (node.name !== undefined ? 1 : 0) : 0;
    case SyntaxKind.TypeParameter:
      return node instanceof TypeParameterDeclaration
        ? (hasModifiers(node.modifiers) ? 1 : 0) |
            (node.name !== undefined ? 2 : 0) |
            (node.constraint !== undefined ? 4 : 0) |
            (node.expression !== undefined ? 8 : 0) |
            (node.defaultType !== undefined ? 16 : 0)
        : 0;
    case SyntaxKind.JSDocTypeLiteral:
      return node instanceof JSDocTypeLiteral ? (hasElements(node.jsdocPropertyTags) ? 1 : 0) : 0;
    case SyntaxKind.JSDocParameterTag:
    case SyntaxKind.JSDocPropertyTag:
      return node instanceof JSDocParameterOrPropertyTag
        ? (node.tagName !== undefined ? 1 : 0) |
            (node.name !== undefined ? 2 : 0) |
            (node.typeExpression !== undefined ? 4 : 0) |
            (node.comment !== undefined ? 8 : 0)
        : 0;
    default:
      return 0;
  }
}

function bit(value: boolean): number {
  return value ? 1 : 0;
}

/** Small per-kind values in bits 24-29 of the data word. */
function commonData(node: Node): number {
  switch (node.kind) {
    case SyntaxKind.Block:
      return node instanceof Block ? bit(node.multiLine) << 24 : 0;
    case SyntaxKind.HeritageClause:
      return node instanceof HeritageClause ? bit(node.token === SyntaxKind.ImplementsKeyword) << 24 : 0;
    case SyntaxKind.ExportAssignment:
      return node instanceof ExportAssignment ? bit(node.isExportEquals) << 24 : 0;
    case SyntaxKind.ExportSpecifier:
      return node instanceof ExportSpecifier ? bit(node.isTypeOnly) << 24 : 0;
    case SyntaxKind.PrefixUnaryExpression:
      return node instanceof PrefixUnaryExpression ? prefixOperatorIndex(node.operator) << 24 : 0;
    case SyntaxKind.PostfixUnaryExpression:
      return node instanceof PostfixUnaryExpression ? bit(node.operator === SyntaxKind.MinusMinusToken) << 24 : 0;
    case SyntaxKind.MetaProperty:
      return node instanceof MetaProperty ? bit(node.keywordToken === SyntaxKind.NewKeyword) << 24 : 0;
    case SyntaxKind.ArrayLiteralExpression:
      return node instanceof ArrayLiteralExpression ? bit(node.multiLine) << 24 : 0;
    case SyntaxKind.ObjectLiteralExpression:
      return node instanceof ObjectLiteralExpression ? bit(node.multiLine) << 24 : 0;
    case SyntaxKind.TypeOperator:
      if (!(node instanceof TypeOperatorNode)) return 0;
      if (node.operator === SyntaxKind.ReadonlyKeyword) return 1 << 24;
      if (node.operator === SyntaxKind.UniqueKeyword) return 2 << 24;
      return 0;
    case SyntaxKind.ImportAttributes:
      return node instanceof ImportAttributes
        ? (bit(node.multiLine) << 24) | (bit(node.token === SyntaxKind.AssertKeyword) << 25)
        : 0;
    case SyntaxKind.JsxText:
      return node instanceof JsxText ? bit(node.containsOnlyTriviaWhiteSpaces) << 24 : 0;
    case SyntaxKind.ModuleDeclaration:
      return node instanceof ModuleDeclaration ? bit(node.keyword === SyntaxKind.NamespaceKeyword) << 24 : 0;
    case SyntaxKind.ImportEqualsDeclaration:
      return node instanceof ImportEqualsDeclaration ? bit(node.isTypeOnly) << 24 : 0;
    case SyntaxKind.ExportDeclaration:
      return node instanceof ExportDeclaration ? bit(node.isTypeOnly) << 24 : 0;
    case SyntaxKind.ImportType:
      return node instanceof ImportTypeNode ? bit(node.isTypeOf) << 24 : 0;
    case SyntaxKind.ImportClause:
      if (!(node instanceof ImportClause)) return 0;
      if (node.phaseModifier === SyntaxKind.TypeKeyword) return 1 << 24;
      if (node.phaseModifier === SyntaxKind.DeferKeyword) return 2 << 24;
      return 0;
    case SyntaxKind.ImportSpecifier:
      return node instanceof ImportSpecifier ? bit(node.isTypeOnly) << 24 : 0;
    case SyntaxKind.JSDocTypeLiteral:
      return node instanceof JSDocTypeLiteral ? bit(node.isArrayType) << 24 : 0;
    case SyntaxKind.JSDocParameterTag:
    case SyntaxKind.JSDocPropertyTag:
      return node instanceof JSDocParameterOrPropertyTag
        ? (bit(node.isBracketed) << 24) | (bit(node.isNameFirst) << 25)
        : 0;
  }
  return 0;
}

function prefixOperatorIndex(operator: SyntaxKind): number {
  switch (operator) {
    case SyntaxKind.MinusToken:
      return 1;
    case SyntaxKind.TildeToken:
      return 2;
    case SyntaxKind.ExclamationToken:
      return 3;
    case SyntaxKind.PlusPlusToken:
      return 4;
    case SyntaxKind.MinusMinusToken:
      return 5;
  }
  return 0;
}

function dataType(kind: SyntaxKind): number {
  switch (kind) {
    case SyntaxKind.Identifier:
    case SyntaxKind.PrivateIdentifier:
    case SyntaxKind.JsxText:
    case SyntaxKind.JSDocText:
    case SyntaxKind.JSDocLink:
    case SyntaxKind.JSDocLinkPlain:
    case SyntaxKind.JSDocLinkCode:
      return dataTypeString;
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NumericLiteral:
    case SyntaxKind.BigIntLiteral:
    case SyntaxKind.RegularExpressionLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
    case SyntaxKind.TemplateHead:
    case SyntaxKind.TemplateMiddle:
    case SyntaxKind.TemplateTail:
    case SyntaxKind.SourceFile:
      return dataTypeExtended;
  }
  return dataTypeChildren;
}

/** The text of a node encoded as a string. */
function nodeText(node: Node): string {
  if (node instanceof Identifier) return node.text;
  if (node instanceof PrivateIdentifier) return node.text;
  if (node instanceof JsxText) return node.text;
  if (node instanceof JSDocText) return node.text;
  if (node instanceof JSDocLink) return node.text;
  if (node instanceof JSDocLinkPlain) return node.text;
  if (node instanceof JSDocLinkCode) return node.text;
  return '';
}

function writeArrayHeader(out: ByteWriter, length: number): void {
  if (length <= 0x0f) out.u8(0x90 | length);
  else if (length <= 0xffff) {
    out.u8(0xdc);
    out.be(length, 2);
  } else {
    out.u8(0xdd);
    out.be(length, 4);
  }
}

function writeUint(out: ByteWriter, value: number): void {
  if (value <= 0x7f) out.u8(value);
  else if (value <= 0xff) {
    out.u8(0xcc);
    out.u8(value);
  } else if (value <= 0xffff) {
    out.u8(0xcd);
    out.be(value, 2);
  } else {
    out.u8(0xce);
    out.be(value, 4);
  }
}

function writeString(out: ByteWriter, text: string): void {
  const bytes = encodeUTF8(text);
  const n = bytes.length;
  if (n <= 0x1f) out.u8(0xa0 | n);
  else if (n <= 0xff) {
    out.u8(0xd9);
    out.u8(n);
  } else if (n <= 0xffff) {
    out.u8(0xda);
    out.be(n, 2);
  } else {
    out.u8(0xdb);
    out.be(n, 4);
  }
  out.append(bytes);
}

function writeFileReferences(out: ByteWriter, refs: readonly FileReference[]): number {
  if (refs.length === 0) return noStructuredData;
  const offset = out.length;
  writeArrayHeader(out, refs.length);
  for (const ref of refs) {
    writeArrayHeader(out, 5);
    writeUint(out, ref.pos);
    writeUint(out, ref.end);
    writeString(out, ref.fileName);
    writeUint(out, ref.resolutionMode);
    out.u8(ref.preserve ? 0xc3 : 0xc2);
  }
  return offset;
}

/** Walks the tree in the API's order and writes node records. */
class Encoder extends NodeVisitor {
  /** The file whose JSDoc comments are encoded, if any. */
  readonly file: SourceFile | undefined;
  readonly strings: StringTable;
  readonly nodes: ByteWriter;
  readonly extended: ByteWriter;
  readonly structured: ByteWriter;
  /** Node indices of imports, module augmentations and the external module indicator. */
  readonly tracked: Map<Node, number>;
  nodeCount: number;
  parentIndex: number;
  prevIndex: number;

  constructor(file: SourceFile | undefined, text: string, fileText: Uint8Array, nodeCount: number) {
    super();
    this.file = file;
    this.strings = new StringTable(text, fileText);
    this.nodes = new ByteWriter((nodeCount + 2) * nodeSize);
    this.extended = new ByteWriter(256);
    this.structured = new ByteWriter(64);
    this.tracked = new Map<Node, number>();
    this.nodeCount = 0;
    this.parentIndex = 0;
    this.prevIndex = 0;
  }

  /** Points the previous sibling's `next` at the record about to be written. */
  private linkSibling(index: number): void {
    if (this.prevIndex !== 0) this.nodes.setU32(this.prevIndex * nodeSize + 12, index);
  }

  visitNode(node: Node): boolean {
    const index = ++this.nodeCount;
    this.linkSibling(index);
    this.nodes.node(node.kind, node.pos, node.end, this.parentIndex, this.nodeData(node), node.flags);
    if (this.tracked.size > 0 && this.tracked.has(node)) this.tracked.set(node, index);
    const saveParent = this.parentIndex;
    this.prevIndex = 0;
    this.parentIndex = index;
    this.visitChildren(node);
    this.prevIndex = index;
    this.parentIndex = saveParent;
    return false;
  }

  visitList(list: NodeList): boolean {
    const index = ++this.nodeCount;
    this.linkSibling(index);
    this.nodes.node(nodeListKind, list.pos, list.end, this.parentIndex, list.nodes.length, 0);
    const saveParent = this.parentIndex;
    this.prevIndex = 0;
    this.parentIndex = index;
    const nodes = list.nodes;
    for (let i = 0; i < nodes.length; i++) this.visitNode(nodes[i]!);
    this.prevIndex = index;
    this.parentIndex = saveParent;
    return false;
  }

  visitModifiers(list: ModifierList): boolean {
    if (list.nodes.length > 0) this.visitList(list);
    return false;
  }

  /** The children in the API's order, then the node's JSDoc comments. */
  visitChildren(node: Node): boolean {
    if (node instanceof JSDocParameterOrPropertyTag) {
      const tag = node;
      this.visitNode(tag.tagName);
      this.visitNode(tag.name);
      if (tag.typeExpression !== undefined) this.visitNode(tag.typeExpression);
      if (tag.comment !== undefined) this.visitList(tag.comment);
    } else node.forEachChild(this);
    const file = this.file;
    if (file !== undefined) {
      const jsDoc = getJSDoc(file, node);
      for (let i = 0; i < jsDoc.length; i++) this.visitNode(jsDoc[i]!);
    }
    return false;
  }

  /** Writes the nil record and the root, then the root's descendants. */
  encodeRoot(root: Node): void {
    const nodes = this.nodes;
    nodes.node(0, 0, 0, 0, 0, 0);
    this.nodeCount = 1;
    this.parentIndex = 1;
    nodes.node(root.kind, root.pos, root.end, 0, this.nodeData(root), root.flags);
    this.visitChildren(root);
  }

  /** The encoding: header, string table, extended and structured data, then node records. */
  finish(fileText: Uint8Array, hash: Uint8Array | undefined, parseOptions: number): Uint8Array {
    const strings = this.strings;
    const extended = this.extended;
    const structured = this.structured;
    const nodes = this.nodes;
    const offsetStringOffsets = headerSize;
    const offsetStringData = offsetStringOffsets + strings.offsets.length;
    const offsetExtended = offsetStringData + fileText.length + strings.others.length;
    const offsetStructured = offsetExtended + extended.length;
    const offsetNodes = offsetStructured + structured.length;

    const out = new ByteWriter(offsetNodes + nodes.length);
    out.u32((protocolVersion << 24) >>> 0);
    if (hash !== undefined) out.append(hash);
    else for (let i = 0; i < 4; i++) out.u32(0);
    out.u32(parseOptions);
    out.u32(offsetStringOffsets);
    out.u32(offsetStringData);
    out.u32(offsetExtended);
    out.u32(offsetStructured);
    out.u32(offsetNodes);
    out.append(strings.offsets.view());
    out.append(fileText);
    out.append(strings.others.view());
    out.append(extended.view());
    out.append(structured.view());
    out.append(nodes.view());
    return out.view();
  }

  nodeData(node: Node): number {
    const type = dataType(node.kind);
    const common = commonData(node);
    if (type === dataTypeChildren) return (type | common | childrenPropertyMask(node)) >>> 0;
    if (type === dataTypeString)
      return (type | common | this.strings.add(nodeText(node), node.kind, node.pos, node.end)) >>> 0;
    return (type | common | this.extendedData(node)) >>> 0;
  }

  /** Writes the node's extended data and returns its offset. */
  extendedData(node: Node): number {
    const out = this.extended;
    const offset = out.length;
    const strings = this.strings;
    if (node instanceof StringLiteral) {
      out.u32(strings.add(node.text, node.kind, node.pos, node.end));
      out.u32(node.tokenFlags);
    } else if (node instanceof NumericLiteral) {
      out.u32(strings.add(node.text, node.kind, node.pos, node.end));
      out.u32(node.tokenFlags);
    } else if (node instanceof BigIntLiteral) {
      out.u32(strings.add(node.text, node.kind, node.pos, node.end));
      out.u32(node.tokenFlags);
    } else if (node instanceof RegularExpressionLiteral) {
      out.u32(strings.add(node.text, node.kind, node.pos, node.end));
      out.u32(node.tokenFlags);
    } else if (node instanceof NoSubstitutionTemplateLiteral) {
      out.u32(strings.add(node.text, node.kind, node.pos, node.end));
      out.u32(node.templateFlags);
    } else if (node instanceof TemplateHead) {
      out.u32(strings.add(node.text, node.kind, node.pos, node.end));
      out.u32(strings.add(node.rawText, node.kind, node.pos, node.end));
      out.u32(node.templateFlags);
    } else if (node instanceof TemplateMiddle) {
      out.u32(strings.add(node.text, node.kind, node.pos, node.end));
      out.u32(strings.add(node.rawText, node.kind, node.pos, node.end));
      out.u32(node.templateFlags);
    } else if (node instanceof TemplateTail) {
      out.u32(strings.add(node.text, node.kind, node.pos, node.end));
      out.u32(strings.add(node.rawText, node.kind, node.pos, node.end));
      out.u32(node.templateFlags);
    } else if (node instanceof SourceFile) {
      out.u32(strings.addFileText(node.pos, node.end));
      out.u32(strings.add(node.fileName, SyntaxKind.Unknown, 0, 0));
      out.u32(strings.add(node.path, SyntaxKind.Unknown, 0, 0));
      out.u32(node.languageVariant);
      out.u32(node.scriptKind);
      out.u32(writeFileReferences(this.structured, node.referencedFiles));
      out.u32(writeFileReferences(this.structured, node.typeReferenceDirectives));
      out.u32(writeFileReferences(this.structured, node.libReferenceDirectives));
      // Imports, module augmentations, ambient module names and the external module
      // indicator are patched in after the walk.
      out.u32(noStructuredData);
      out.u32(noStructuredData);
      out.u32(noStructuredData);
      out.u32(0);
    } else throw new Error(`no extended data for kind ${node.kind}`);
    return offset;
  }

  writeNodeIndices(nodes: readonly Node[]): number {
    if (nodes.length === 0) return noStructuredData;
    const out = this.structured;
    const offset = out.length;
    writeArrayHeader(out, nodes.length);
    for (const node of nodes) {
      const index = this.tracked.get(node);
      writeUint(out, index === undefined ? 0 : index);
    }
    return offset;
  }

  writeStrings(strings: readonly string[]): number {
    if (strings.length === 0) return noStructuredData;
    const out = this.structured;
    const offset = out.length;
    writeArrayHeader(out, strings.length);
    for (const text of strings) writeString(out, text);
    return offset;
  }
}

/** The API's binary encoding of `file`. */
export function encodeSourceFile(file: SourceFile): Uint8Array {
  const fileText = utf8Encoder.encode(file.text);
  const encoder = new Encoder(file, file.text, fileText, file.nodeCount);
  const tracked = encoder.tracked;
  for (const node of file.imports) tracked.set(node, 0);
  for (const node of file.moduleAugmentations) tracked.set(node, 0);
  const indicator = file.externalModuleIndicator;
  if (indicator !== undefined && indicator !== file) tracked.set(indicator, 0);

  // The root's extended data starts its section.
  encoder.encodeRoot(file);

  const extended = encoder.extended;
  extended.setU32(32, encoder.writeNodeIndices(file.imports));
  extended.setU32(36, encoder.writeNodeIndices(file.moduleAugmentations));
  extended.setU32(40, encoder.writeStrings(file.ambientModuleNames));
  let indicatorIndex = 0;
  if (indicator === file) indicatorIndex = 1;
  else if (indicator !== undefined) {
    const index = tracked.get(indicator);
    if (index !== undefined) indicatorIndex = index;
  }
  extended.setU32(44, indicatorIndex);

  const options = file.externalModuleIndicatorOptions;
  return encoder.finish(fileText, hash128(fileText), (options.jsx ? 1 : 0) | (options.force ? 2 : 0));
}

/**
 * The nodes of a source file by their index in its encoding, which node handles name. Node lists
 * take an index but have no entry.
 */
export class NodeIndexTable extends NodeVisitor {
  /** Index 0 is the nil node and index 1 the file. */
  readonly nodes: (Node | undefined)[];
  private readonly indices = new Map<Node, number>();

  constructor(readonly file: SourceFile) {
    super();
    this.nodes = [undefined];
    this.add(file);
    this.visitChildren(file);
  }

  /** The index of `node`, or 0 if it isn't in the file. */
  indexOf(node: Node): number {
    return this.indices.get(node) ?? 0;
  }

  private add(node: Node): void {
    this.indices.set(node, this.nodes.length);
    this.nodes.push(node);
  }

  visitNode(node: Node): boolean {
    this.add(node);
    this.visitChildren(node);
    return false;
  }

  visitList(list: NodeList): boolean {
    this.nodes.push(undefined);
    const nodes = list.nodes;
    for (let i = 0; i < nodes.length; i++) this.visitNode(nodes[i]!);
    return false;
  }

  visitModifiers(list: ModifierList): boolean {
    if (list.nodes.length > 0) this.visitList(list);
    return false;
  }

  /** The same order as the encoder's. */
  private visitChildren(node: Node): void {
    if (node instanceof JSDocParameterOrPropertyTag) {
      const tag = node;
      this.visitNode(tag.tagName);
      this.visitNode(tag.name);
      if (tag.typeExpression !== undefined) this.visitNode(tag.typeExpression);
      if (tag.comment !== undefined) this.visitList(tag.comment);
    } else node.forEachChild(this);
    const jsDoc = getJSDoc(this.file, node);
    for (let i = 0; i < jsDoc.length; i++) this.visitNode(jsDoc[i]!);
  }
}

/**
 * The encoding of a node that isn't part of a parsed file, such as one the node builder created:
 * no hash, parse options or JSDoc, every string appended to the string data, and positions as they are.
 */
export function encodeNode(node: Node): Uint8Array {
  const fileText = new Uint8Array(0);
  const encoder = new Encoder(undefined, '', fileText, 64);
  encoder.encodeRoot(node);
  return encoder.finish(fileText, undefined, 0);
}
