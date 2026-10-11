// Runtime helpers for legacy (`experimentalDecorators`) and standard decorators, and the
// function-naming helpers class transforms share.
import { ArrayLiteralExpression, type CallExpression, type Node } from '../ast.js';
import { TokenFlags } from '../types.js';
import type { NodeFactory } from './factory.js';
import { EmitHelper, noPriority } from './helpers.js';

export const decorateHelper = new EmitHelper(
  'typescript:decorate',
  false,
  `var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};`,
  2,
  [],
  '__decorate',
  '',
);

export const metadataHelper = new EmitHelper(
  'typescript:metadata',
  false,
  `var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};`,
  3,
  [],
  '__metadata',
  '',
);

export const paramHelper = new EmitHelper(
  'typescript:param',
  false,
  `var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};`,
  4,
  [],
  '__param',
  '',
);

export const esDecorateHelper = new EmitHelper(
  'typescript:esDecorate',
  false,
  `var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};`,
  2,
  [],
  '__esDecorate',
  '',
);

export const runInitializersHelper = new EmitHelper(
  'typescript:runInitializers',
  false,
  `var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};`,
  2,
  [],
  '__runInitializers',
  '',
);

export const propKeyHelper = new EmitHelper(
  'typescript:propKey',
  false,
  `var __propKey = (this && this.__propKey) || function (x) {
    return typeof x === "symbol" ? x : "".concat(x);
};`,
  noPriority,
  [],
  '__propKey',
  '',
);

export const setFunctionNameHelper = new EmitHelper(
  'typescript:setFunctionName',
  false,
  `var __setFunctionName = (this && this.__setFunctionName) || function (f, name, prefix) {
    if (typeof name === "symbol") name = name.description ? "[".concat(name.description, "]") : "";
    return Object.defineProperty(f, "name", { configurable: true, value: prefix ? "".concat(prefix, " ", name) : name });
};`,
  noPriority,
  [],
  '__setFunctionName',
  '',
);

/** `__decorate([decorators], target, memberName, descriptor)`; the member name and descriptor are optional. */
export function createDecorateHelper(
  factory: NodeFactory,
  decorators: Node[],
  target: Node,
  memberName: Node | undefined,
  descriptor: Node | undefined,
): CallExpression {
  factory.context.requestEmitHelper(decorateHelper);
  const args: Node[] = [factory.created(new ArrayLiteralExpression(factory.createNodeList(decorators), true)), target];
  if (memberName !== undefined) {
    args.push(memberName);
    if (descriptor !== undefined) args.push(descriptor);
  }
  return factory.createCallExpression(factory.createUnscopedHelperName('__decorate'), args);
}

/** `__metadata("key", value)` */
export function createMetadataHelper(factory: NodeFactory, key: string, value: Node): CallExpression {
  factory.context.requestEmitHelper(metadataHelper);
  return factory.createCallExpression(factory.createUnscopedHelperName('__metadata'), [
    factory.createStringLiteral(key, TokenFlags.None),
    value,
  ]);
}

/** `__param(index, decorator)`, with the range of the decorator. */
export function createParamHelper(
  factory: NodeFactory,
  expression: Node,
  parameterOffset: number,
  pos: number,
  end: number,
): CallExpression {
  factory.context.requestEmitHelper(paramHelper);
  const helper = factory.createCallExpression(factory.createUnscopedHelperName('__param'), [
    factory.createNumericLiteral(String(parameterOffset)),
    expression,
  ]);
  helper.pos = pos | 0;
  helper.end = end | 0;
  return helper;
}

/** `__esDecorate(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers)` */
export function createESDecorateHelper(
  factory: NodeFactory,
  ctor: Node,
  descriptorIn: Node,
  decorators: Node,
  contextIn: Node,
  initializers: Node,
  extraInitializers: Node,
): CallExpression {
  factory.context.requestEmitHelper(esDecorateHelper);
  return factory.createCallExpression(factory.createUnscopedHelperName('__esDecorate'), [
    ctor,
    descriptorIn,
    decorators,
    contextIn,
    initializers,
    extraInitializers,
  ]);
}

/** `__runInitializers(thisArg, initializers, value)`; the value is optional. */
export function createRunInitializersHelper(
  factory: NodeFactory,
  thisArg: Node,
  initializers: Node,
  value: Node | undefined,
): CallExpression {
  factory.context.requestEmitHelper(runInitializersHelper);
  const args = value !== undefined ? [thisArg, initializers, value] : [thisArg, initializers];
  return factory.createCallExpression(factory.createUnscopedHelperName('__runInitializers'), args);
}

/** `__propKey(expression)` */
export function createPropKeyHelper(factory: NodeFactory, expression: Node): CallExpression {
  factory.context.requestEmitHelper(propKeyHelper);
  return factory.createCallExpression(factory.createUnscopedHelperName('__propKey'), [expression]);
}

/** `__setFunctionName(fn, name, "prefix")`; an empty prefix is omitted. */
export function createSetFunctionNameHelper(
  factory: NodeFactory,
  fn: Node,
  name: Node,
  prefix: string,
): CallExpression {
  factory.context.requestEmitHelper(setFunctionNameHelper);
  const args: Node[] = [fn, name];
  if (prefix.length > 0) args.push(factory.createStringLiteral(prefix, TokenFlags.None));
  return factory.createCallExpression(factory.createUnscopedHelperName('__setFunctionName'), args);
}
