// Generates the node classes and shared-field accessors in src/compiler/ast.ts from
// typescript-go's _scripts/ast.json. Only the marked regions of ast.ts are rewritten.
//
// Usage: node scripts/generate-ast.mjs [--schema PATH]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const schemaAt = args.indexOf('--schema');
const schemaPath =
  schemaAt >= 0 ? resolve(args[schemaAt + 1]) : resolve(root, '../../upstream/typescript-go/_scripts/ast.json');
const astPath = join(root, 'src/compiler/ast.ts');

const spec = JSON.parse(readFileSync(schemaPath, 'utf8'));
const bases = spec.bases;
const defs = spec.nodes.definitions;

// Members the schema marks required but the parser can leave unset.
const nullable = new Set([
  'PropertySignatureDeclaration.Type',
  'PropertySignatureDeclaration.Initializer',
  'PropertyAssignment.Type',
  'ShorthandPropertyAssignment.Type',
  'ExportAssignment.Type',
  'JSDocTemplateTag.Constraint',
  'TaggedTemplateExpression.QuestionDotToken',
  'BinaryExpression.Type',
  'JSDocTypeTag.TypeExpression',
  'ImportAttribute.name',
  'BindingElement.name',
  'CaseOrDefaultClause.Expression',
  'IndexSignatureDeclaration.Type',
  'JSDocSeeTag.NameExpression',
  'JSDocNameReference.name',
  // tsgo's node builder leaves it unset.
  'ArrowFunction.EqualsGreaterThanToken',
]);
// Checker-only nodes.
const skipNodes = new Set(['SyntheticExpression']);
// Hand-written in ast.ts.
const handWritten = new Set(['SourceFile', 'JSDocParameterOrPropertyTag']);
// Created only by transforms. scriptc can't narrow to a class a program never constructs, so the
// accessors leave these out until the transforms exist.
const transformOnly = new Set([
  'PartiallyEmittedExpression',
  'SyntheticReferenceExpression',
  'NotEmittedStatement',
  'NotEmittedTypeElement',
  'SyntaxList',
]);
// Kinds sharing one class, which the schema leaves implicit.
const multiKinds = {
  ForInOrOfStatement: ['ForInStatement', 'ForOfStatement'],
  CaseOrDefaultClause: ['CaseClause', 'DefaultClause'],
  BindingPattern: ['ObjectBindingPattern', 'ArrayBindingPattern'],
  JSDocParameterOrPropertyTag: ['JSDocParameterTag', 'JSDocPropertyTag'],
  KeywordExpression: ['NullKeyword', 'TrueKeyword', 'FalseKeyword', 'ThisKeyword', 'SuperKeyword', 'ImportKeyword'],
};
// Literal flags the factory masks, as tsgo's NodeFactory does.
const flagMasks = {
  StringLiteral: 'StringLiteralFlags',
  NumericLiteral: 'NumericLiteralFlags',
  BigIntLiteral: 'NumericLiteralFlags',
  RegularExpressionLiteral: 'RegularExpressionLiteralFlags',
  NoSubstitutionTemplateLiteral: 'TemplateLiteralLikeFlags',
  TemplateHead: 'TemplateLiteralLikeFlags',
  TemplateMiddle: 'TemplateLiteralLikeFlags',
  TemplateTail: 'TemplateLiteralLikeFlags',
};
// Member types that are always one class; other node-valued members are typed by category (`Node` aliases).
const classTypes = new Set([
  'Identifier',
  'Block',
  'CaseBlock',
  'CatchClause',
  'VariableDeclaration',
  'VariableDeclarationList',
  'ImportClause',
  'ImportAttributes',
  'JsxAttributes',
  'JsxOpeningElement',
  'JsxClosingElement',
  'JsxOpeningFragment',
  'JsxClosingFragment',
  'TemplateHead',
  'TypeParameterDeclaration',
  'ExpressionWithTypeArguments',
]);
const tokenTypes = new Set([
  'AssertsKeyword',
  'AsteriskToken',
  'AwaitKeyword',
  'BinaryOperatorToken',
  'ColonToken',
  'DotDotDotToken',
  'EndOfFile',
  'EqualsGreaterThanToken',
  'EqualsToken',
  'ExclamationToken',
  'QuestionDotToken',
  'QuestionToken',
  'QuestionToken|ExclamationToken',
  'QuestionToken|PlusToken|MinusToken',
  'ReadonlyKeyword|PlusToken|MinusToken',
]);
const scalarTypes = new Set(['bool', 'string', 'TokenFlags', 'NodeFlags', 'ImportPhaseModifierSyntaxKind']);

// Fields the binder sets, which the schema marks Go-only, and their types.
const binderFieldTypes = {
  Symbol: 'Symbol',
  LocalSymbol: 'Symbol',
  Locals: 'SymbolTable',
  NextContainer: 'Node',
  FlowNode: 'FlowNode',
  EndFlowNode: 'FlowNode',
  ReturnFlowNode: 'FlowNode',
  FallthroughFlowNode: 'FlowNode',
};

function fieldName(name) {
  if (name.startsWith('JSDoc')) return 'jsdoc' + name.slice(5);
  return name.charAt(0).toLowerCase() + name.slice(1);
}

const paramName = (name) => (name === 'arguments' ? 'args' : name);

function baseField(baseNames, name) {
  for (const bn of baseNames) {
    const b = bases[bn];
    if (b !== undefined && b.fields !== undefined && b.fields[name] !== undefined) return b.fields[name];
  }
  for (const bn of baseNames) {
    const b = bases[bn];
    if (b === undefined) continue;
    const found = baseField(b.extends ?? [], name);
    if (found !== undefined) return found;
  }
  return undefined;
}

function typeName(type) {
  return Array.isArray(type) ? type.join('|') : type;
}

function tsType(type) {
  const t = typeName(type);
  if (t === 'bool') return 'boolean';
  if (t === 'string' || t === 'TokenFlags' || t === 'NodeFlags') return t;
  if (t.startsWith('SyntaxKind.') || t === 'ImportPhaseModifierSyntaxKind') return 'SyntaxKind';
  if (tokenTypes.has(t)) return 'Token';
  return t;
}

/** The binder fields of a node definition, from its bases and its own members. */
function binderFields(def) {
  const result = [];
  const add = (name) => {
    const type = binderFieldTypes[name];
    if (type !== undefined && !result.some((f) => f.name === fieldName(name)))
      result.push({ name: fieldName(name), type });
  };
  const seen = new Set();
  const visit = (names) => {
    for (const bn of names) {
      const b = bases[bn];
      if (b === undefined || seen.has(bn)) continue;
      seen.add(bn);
      visit(b.extends ?? []);
      for (const [name, field] of Object.entries(b.fields ?? {})) if (field.goOnly) add(name);
    }
  };
  visit(def.extends ?? []);
  for (const m of def.members ?? []) if (m.goOnly) add(m.name);
  return result;
}

/** The node classes, with their kinds and members in factory/visitor order. */
function nodeClasses() {
  const classes = [];
  for (const [name, def] of Object.entries(defs)) {
    if (skipNodes.has(name)) continue;
    const kinds =
      multiKinds[name] ?? (def.kind === undefined ? [name] : Array.isArray(def.kind) ? def.kind : [def.kind]);
    const members = [];
    let hasKindParam = false;
    for (const m of def.members ?? []) {
      let field = m;
      if (m.inherited) {
        if (m.name === 'Kind') {
          hasKindParam = true;
          continue;
        }
        const base = baseField(def.extends, m.name);
        if (base === undefined) throw new Error(`${name}.${m.name}`);
        field = {
          ...base,
          ...Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'inherited' && k !== 'name')),
        };
      }
      if (field.goOnly) continue;
      if (m.name === 'Flags') {
        members.push({ name: 'flags', isFlags: true, type: 'NodeFlags' });
        continue;
      }
      let type;
      let child = undefined;
      if (field.list === 'NodeList') {
        type = 'NodeList';
        child = 'list';
      } else if (field.list === 'ModifierList') {
        type = 'ModifierList';
        child = 'modifiers';
      } else if (field.list === 'raw') {
        if (field.type === 'string') type = 'string';
        else {
          type = 'Node[]';
          child = 'raw';
        }
      } else {
        type = tsType(field.type);
        const t = typeName(field.type);
        if (!scalarTypes.has(t) && !t.startsWith('SyntaxKind.')) child = 'node';
      }
      const optional = field.optional === true || nullable.has(`${name}.${m.name}`);
      members.push({ name: fieldName(m.name), type, optional, child });
    }
    classes.push({ name, kinds, members, hasKindParam, binder: binderFields(def) });
  }
  return classes;
}

function emitClass(c) {
  const lines = [];
  const kindLiteral = c.kinds.length === 1 && !c.hasKindParam;
  const fields = c.members.filter((m) => !m.isFlags);
  const type = (m) => `${m.type}${m.optional ? ' | undefined' : ''}`;
  const params = [];
  if (!kindLiteral) params.push('kind: SyntaxKind');
  for (const m of c.members) params.push(m.isFlags ? 'flags: NodeFlags' : `${paramName(m.name)}: ${type(m)}`);
  lines.push(`export class ${c.name} extends Node {`);
  for (const m of fields) lines.push(`  ${m.name}: ${type(m)};`);
  if (c.binder.length > 0) {
    lines.push('  // Set by the binder.');
    for (const f of c.binder) lines.push(`  ${f.name}: ${f.type} | undefined;`);
  }
  if (fields.length > 0 || c.binder.length > 0) lines.push('');
  lines.push(`  constructor(${params.join(', ')}) {`);
  lines.push(`    super(${kindLiteral ? 'SyntaxKind.' + c.kinds[0] : 'kind'});`);
  for (const m of c.members) {
    if (m.isFlags)
      lines.push(
        c.name === 'VariableDeclarationList'
          ? '    this.flags = flags;'
          : '    this.flags |= flags & NodeFlags.OptionalChain;',
      );
    else if (m.type === 'TokenFlags' && flagMasks[c.name] !== undefined)
      lines.push(`    this.${m.name} = ${paramName(m.name)} & TokenFlags.${flagMasks[c.name]};`);
    else lines.push(`    this.${m.name} = ${paramName(m.name)};`);
  }
  for (const f of c.binder) lines.push(`    this.${f.name} = undefined;`);
  lines.push('  }');
  lines.push('');
  const children = fields.filter((m) => m.child !== undefined);
  lines.push(`  forEachChild(${children.length > 0 ? 'v' : '_v'}: NodeVisitor): boolean {`);
  children.forEach((m, i) => {
    const last = i === children.length - 1;
    const f = `this.${m.name}`;
    if (m.child === 'raw') {
      lines.push(
        m.optional
          ? `    if (${f} !== undefined) for (const node of ${f}) if (v.visitNode(node)) return true;`
          : `    for (const node of ${f}) if (v.visitNode(node)) return true;`,
      );
      if (last) lines.push('    return false;');
      return;
    }
    const call =
      m.child === 'node' ? `v.visitNode(${f})` : m.child === 'list' ? `v.visitList(${f})` : `v.visitModifiers(${f})`;
    if (last) lines.push(m.optional ? `    return ${f} !== undefined && ${call};` : `    return ${call};`);
    else
      lines.push(m.optional ? `    if (${f} !== undefined && ${call}) return true;` : `    if (${call}) return true;`);
  });
  if (children.length === 0) lines.push('    return false;');
  lines.push('  }');
  lines.push('');
  lines.push('  setParentOfChildren(): void {');
  for (const m of children) {
    const f = `this.${m.name}`;
    const set =
      m.child === 'node'
        ? `${f}.parent = this;`
        : m.child === 'raw'
          ? `setParents(${f}, this);`
          : `setParents(${f}.nodes, this);`;
    lines.push(m.optional || m.child === 'modifiers' ? `    if (${f} !== undefined) ${set}` : `    ${set}`);
  }
  lines.push('  }');
  lines.push('');
  // deepClone/copy: `copy` keeps the class type for class-typed members (scriptc can't override
  // with a narrower return type).
  const args = [];
  if (!kindLiteral) args.push('this.kind');
  for (const m of c.members) {
    if (m.isFlags) {
      args.push('this.flags');
      continue;
    }
    const f = `this.${m.name}`;
    const orUndefined = (expr) => (m.optional ? `${f} === undefined ? undefined : ${expr}` : expr);
    if (m.child === 'node')
      args.push(orUndefined(`${f}.${m.type === 'Token' || classTypes.has(m.type) ? 'copy' : 'deepClone'}()`));
    else if (m.child === 'list') args.push(orUndefined(`cloneList(${f})`));
    else if (m.child === 'modifiers') args.push(`${f} === undefined ? undefined : cloneModifiers(${f})`);
    else if (m.child === 'raw') args.push(orUndefined(`cloneNodes(${f})`));
    else args.push(f);
  }
  lines.push('  deepClone(): Node {');
  lines.push('    return this.copy();');
  lines.push('  }');
  lines.push('');
  lines.push(`  copy(): ${c.name} {`);
  lines.push(`    const node = new ${c.name}(${args.join(', ')});`);
  lines.push('    node.flags = this.flags;');
  lines.push('    node.pos = this.pos;');
  lines.push('    node.end = this.end;');
  lines.push('    return node;');
  lines.push('  }');
  lines.push('}');
  return lines.join('\n');
}

// Fields with an accessor function, like tsgo's Node.Name(), Node.Type(), ….
const accessorFields = [
  'name',
  'modifiers',
  'typeParameters',
  'parameters',
  'type',
  'body',
  'expression',
  'initializer',
  'postfixToken',
  'typeArguments',
  'arguments',
  'members',
  'statements',
  'elements',
  'properties',
  'typeExpression',
  'tagName',
  'comment',
  'isTypeOnly',
  'importClause',
  'moduleSpecifier',
  'dotDotDotToken',
  'asteriskToken',
  'questionToken',
  'text',
  'heritageClauses',
  'label',
  'statement',
  'literal',
  'propertyName',
];
const plainTypes = new Set(['NodeList', 'ModifierList', 'boolean', 'string', 'Node[]']);

function emitAccessors(classes) {
  const result = [];
  for (const field of accessorFields) {
    const holders = [];
    for (const c of classes) {
      if (transformOnly.has(c.name)) continue;
      const m = c.members.find((f) => f.name === field);
      if (m !== undefined) holders.push(c);
    }
    if (holders.length < 2) continue;
    const types = new Set(
      holders.map((c) => {
        const m = c.members.find((f) => f.name === field);
        return plainTypes.has(m.type) ? m.type : 'Node';
      }),
    );
    if (types.size > 1) throw new Error(`mixed accessor types for ${field}`);
    const t = [...types][0];
    const fn = 'get' + field.charAt(0).toUpperCase() + field.slice(1);
    const ret = t === 'boolean' ? 'boolean' : t === 'string' ? 'string' : `${t} | undefined`;
    const fallback = t === 'boolean' ? 'false' : t === 'string' ? "''" : 'undefined';
    const lines = [`export function ${fn}(node: Node): ${ret} {`, '  switch (node.kind) {'];
    for (const c of holders) {
      for (const k of c.kinds) lines.push(`    case SyntaxKind.${k}:`);
      lines.push(
        `      if (node instanceof ${c.name}) {`,
        `        const holder: ${c.name} = node;`,
        `        return holder.${field};`,
        '      }',
      );
      lines.push('      break;');
    }
    lines.push('  }', `  return ${fallback};`, '}');
    result.push(lines.join('\n'));
  }
  return result.join('\n\n');
}

function replaceRegion(text, name, body) {
  const begin = `// #region ${name} (generated by scripts/generate-ast.mjs)\n`;
  const end = `// #endregion ${name}\n`;
  const start = text.indexOf(begin);
  const stop = text.indexOf(end);
  if (start < 0 || stop < start) throw new Error(`missing region ${name} in ast.ts`);
  return text.substring(0, start + begin.length) + '\n' + body + '\n\n' + text.substring(stop);
}

/** Getters and setters for the binder fields, and predicates for the classes that have them. */
function emitBinderAccessors(classes) {
  const result = [];
  const holdersOf = (field) =>
    classes.filter((c) => !transformOnly.has(c.name) && c.binder.some((f) => f.name === field));
  const caseLines = (holders) => holders.flatMap((c) => c.kinds.map((k) => `    case SyntaxKind.${k}:`));
  const predicates = { isDeclarationNode: 'symbol', isLocalsContainer: 'locals' };
  for (const [fn, field] of Object.entries(predicates)) {
    result.push(
      [
        `export function ${fn}(node: Node): boolean {`,
        '  switch (node.kind) {',
        ...caseLines(holdersOf(field)),
        '      return true;',
        '  }',
        '  return false;',
        '}',
      ].join('\n'),
    );
  }
  for (const field of Object.keys(binderFieldTypes).map(fieldName)) {
    const holders = holdersOf(field);
    if (holders.length < 2) continue;
    const type = holders[0].binder.find((f) => f.name === field).type;
    const suffix = field.charAt(0).toUpperCase() + field.slice(1);
    const getter = [`export function get${suffix}(node: Node): ${type} | undefined {`, '  switch (node.kind) {'];
    const setter = [
      `export function set${suffix}(node: Node, value: ${type} | undefined): void {`,
      '  switch (node.kind) {',
    ];
    for (const c of holders) {
      for (const k of c.kinds) {
        getter.push(`    case SyntaxKind.${k}:`);
        setter.push(`    case SyntaxKind.${k}:`);
      }
      // Through typed locals: scriptc reads and writes fields of a narrowed parameter dynamically.
      getter.push(
        `      if (node instanceof ${c.name}) {`,
        `        const holder: ${c.name} = node;`,
        `        return holder.${field};`,
        '      }',
        '      break;',
      );
      setter.push(
        `      if (node instanceof ${c.name}) {`,
        `        const target: ${c.name} = node;`,
        `        target.${field} = value;`,
        '      }',
        '      break;',
      );
    }
    getter.push('  }', '  return undefined;', '}');
    setter.push('  }', '}');
    result.push(getter.join('\n'), setter.join('\n'));
  }
  return result.join('\n\n');
}

const classes = nodeClasses();
// The hand-written classes' fields, for the accessors.
const handFields = {
  SourceFile: [{ name: 'statements', type: 'NodeList' }],
  JSDocParameterOrPropertyTag: [
    { name: 'tagName', type: 'Identifier' },
    { name: 'name', type: 'EntityName' },
    { name: 'isBracketed', type: 'boolean' },
    { name: 'typeExpression', type: 'TypeNode', optional: true },
    { name: 'comment', type: 'NodeList', optional: true },
  ],
};
for (const c of classes) if (handFields[c.name] !== undefined) c.members = handFields[c.name];
let text = readFileSync(astPath, 'utf8');
text = replaceRegion(
  text,
  'nodes',
  classes
    .filter((c) => !handWritten.has(c.name))
    .map(emitClass)
    .join('\n\n'),
);
text = replaceRegion(text, 'accessors', emitAccessors(classes) + '\n\n' + emitBinderAccessors(classes));
writeFileSync(astPath, text);
execFileSync(resolve(root, '../../node_modules/.bin/oxfmt'), [astPath], { stdio: 'inherit' });
