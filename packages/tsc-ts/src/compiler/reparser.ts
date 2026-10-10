// Reparsing of JSDoc in JavaScript files into TypeScript syntax, a port of tsgo's parser/reparser.go.
//
// Hosted tags (`@type`, `@param`, `@returns`, …) add children to the node they document; unhosted
// tags (`@typedef`, `@callback`, `@import`, `@overload`) produce declarations in `Parser.reparseList`.
// Reparsed nodes are flagged `NodeFlags.Reparsed`.
import {
  ArrayTypeNode,
  ArrowFunction,
  AsExpression,
  BinaryExpression,
  CallSignatureDeclaration,
  ClassDeclaration,
  ClassExpression,
  ConstructSignatureDeclaration,
  ConstructorDeclaration,
  ConstructorTypeNode,
  ElementAccessExpression,
  ExportAssignment,
  ExpressionStatement,
  ExpressionWithTypeArguments,
  FunctionDeclaration,
  FunctionExpression,
  FunctionTypeNode,
  GetAccessorDeclaration,
  HeritageClause,
  Identifier,
  type ImportAttributes,
  ImportDeclaration,
  IndexSignatureDeclaration,
  JSDoc,
  JSDocAugmentsTag,
  JSDocCallbackTag,
  JSDocImplementsTag,
  JSDocImportTag,
  JSDocOverloadTag,
  JSDocParameterOrPropertyTag,
  JSDocSatisfiesTag,
  JSDocSignature,
  JSDocTemplateTag,
  JSDocThisTag,
  JSDocTypeExpression,
  JSDocTypeLiteral,
  JSDocTypedefTag,
  JSDocVariadicType,
  JSDocOptionalType,
  KeywordTypeNode,
  MethodDeclaration,
  MethodSignatureDeclaration,
  ModifierList,
  ModuleBlock,
  ModuleDeclaration,
  type Node,
  NodeFlags,
  NodeList,
  NodeVisitor,
  NumericLiteral,
  ParameterDeclaration,
  ParenthesizedExpression,
  PropertyAccessExpression,
  PropertyAssignment,
  PropertyDeclaration,
  PropertySignatureDeclaration,
  QualifiedName,
  ReturnStatement,
  SatisfiesExpression,
  SetAccessorDeclaration,
  ShorthandPropertyAssignment,
  StringLiteral,
  Token,
  TypeAliasDeclaration,
  TypeLiteralNode,
  TypeParameterDeclaration,
  VariableDeclaration,
  VariableStatement,
  getComment,
  getModifiers,
  getName,
  getParameters,
  getText,
  getType,
  getTypeExpression,
  getTypeParameters,
  type TypeNode,
} from './ast.js';
import {
  isAssignmentOperator,
  isFunctionLike,
  isInJSFile,
  isLeftHandSideExpression,
  isStringLiteralLike,
} from './ast-utilities.js';
import { isIdentifierPart, isIdentifierStart } from './character-codes.js';
import { Diagnostics } from './diagnostic-messages.js';
import type { Parser } from './parser.js';
import { SyntaxKind } from './syntax-kind.js';
import { TokenFlags } from './types.js';

/** Sets the parent of every node in a subtree. */
class ParentInChildrenSetter extends NodeVisitor {
  parent: Node | undefined = undefined;

  visitNode(node: Node): boolean {
    node.parent = this.parent;
    const saveParent = this.parent;
    this.parent = node;
    node.forEachChild(this);
    this.parent = saveParent;
    return false;
  }
}

export class Reparser {
  readonly p: Parser;
  private readonly parentSetter: ParentInChildrenSetter;

  constructor(p: Parser) {
    this.p = p;
    this.parentSetter = new ParentInChildrenSetter();
  }

  // Node helpers

  finishReparsedNode(node: Node, locationNode: Node): Node {
    node.flags = this.p.contextFlags | NodeFlags.Reparsed;
    node.pos = locationNode.pos;
    node.end = locationNode.end;
    this.p.overrideParentInImmediateChildren(node);
    return node;
  }

  finishMutatedNode(node: Node): Node {
    this.p.overrideParentInImmediateChildren(node);
    return node;
  }

  /** Sets parents in a cloned subtree and flags its root as reparsed. */
  finishClone(clone: Node): Node {
    const setter = this.parentSetter;
    setter.parent = clone;
    clone.forEachChild(setter);
    setter.parent = undefined;
    clone.flags |= NodeFlags.Reparsed;
    return clone;
  }

  /** A reparsed deep clone, not recorded in `reparsedClones`. */
  deepCloneReparse(node: Node): Node {
    return this.finishClone(node.deepClone());
  }

  /**
   * A reparsed deep clone, recorded in `reparsedClones`: the binder attaches symbols to reparsed nodes,
   * and the list maps JSDoc nodes to them.
   */
  addDeepCloneReparse(node: Node): Node {
    const clone = this.deepCloneReparse(node);
    this.p.reparsedClones.push(clone);
    return clone;
  }

  addDeepCloneReparseIdentifier(node: Identifier): Identifier {
    const clone = node.deepClone();
    this.finishClone(clone);
    this.p.reparsedClones.push(clone);
    return clone;
  }

  addTransformedReparse(newNode: Node, old: Node): Node {
    this.finishReparsedNode(newNode, old);
    newNode.flags |= NodeFlags.ReparserTransformedLiteral;
    this.p.reparsedClones.push(newNode);
    return newNode;
  }

  /** A deep clone of modifiers, without reparsed flags or parents. */
  cloneModifiers(modifiers: ModifierList | undefined): ModifierList | undefined {
    if (modifiers === undefined) return undefined;
    const nodes: Node[] = [];
    for (const m of modifiers.nodes) nodes.push(m.deepClone());
    return new ModifierList(modifiers.pos, modifiers.end, nodes, modifiers.modifierFlags);
  }

  /** Reports an invalid identifier name, at the preceding character if it's missing. */
  checkNonIdentifierName(name: Node): Node {
    if (name instanceof Identifier && !isValidIdentifier(name.text)) {
      if (name.end - name.pos === 0) this.p.parseErrorAt(name.pos - 1, name.pos, Diagnostics.Identifier_expected);
      else this.p.parseErrorAt(name.pos, name.end, Diagnostics.Identifier_expected);
    }
    return name;
  }

  // Tags

  reparseTags(parent: Node, jsDoc: readonly Node[]): boolean {
    let index = 0;
    for (const doc of jsDoc) {
      const isLast = index === jsDoc.length - 1;
      index++;
      if (!(doc instanceof JSDoc) || doc.tags === undefined) continue;
      for (const tag of doc.tags.nodes) {
        this.reparseUnhosted(tag, parent, doc);
        if (isLast) this.reparseHosted(tag, parent, doc);
      }
    }
    return true;
  }

  reparseUnhosted(tag: Node, parent: Node, jsDoc: JSDoc): boolean {
    const p = this.p;
    if (tag instanceof JSDocTypedefTag) {
      const typeExpression = tag.typeExpression;
      if (typeExpression === undefined) return false;
      const fullName = tag.name;
      const modifiers = fullName instanceof ModuleDeclaration ? this.createExportModifier(tag) : undefined;
      const name = this.cloneTypeAliasName(
        this.checkNonIdentifierName(this.getInnermostNameOfJSDocNamespace(fullName)!),
      );
      const typeParameters = this.gatherTypeParameters(jsDoc, true);
      let type: Node;
      if (typeExpression instanceof JSDocTypeExpression) type = this.addDeepCloneReparse(typeExpression.type);
      else if (typeExpression instanceof JSDocTypeLiteral) type = this.reparseJSDocTypeLiteral(typeExpression);
      else throw new Error('typedef tag type expression should be a name reference or a type expression');
      const typeAlias = new TypeAliasDeclaration(
        SyntaxKind.JSTypeAliasDeclaration,
        modifiers,
        name,
        typeParameters,
        type,
      );
      this.finishReparsedNode(typeAlias, tag);
      this.attachReparsedJSDoc(typeAlias, jsDoc);
      p.reparseList.push(this.wrapInJSDocNamespace(fullName, typeAlias, false));
      return true;
    }
    if (tag instanceof JSDocCallbackTag) {
      const fullName = tag.name;
      const modifiers = fullName instanceof ModuleDeclaration ? this.createExportModifier(tag) : undefined;
      const functionType = this.reparseJSDocSignature(tag.typeExpression, tag, jsDoc, tag, undefined);
      const name = this.cloneTypeAliasName(this.getInnermostNameOfJSDocNamespace(fullName)!);
      const typeParameters = this.gatherTypeParameters(jsDoc, true);
      const typeAlias = new TypeAliasDeclaration(
        SyntaxKind.JSTypeAliasDeclaration,
        modifiers,
        name,
        typeParameters,
        functionType,
      );
      this.finishReparsedNode(typeAlias, tag);
      this.attachReparsedJSDoc(typeAlias, jsDoc);
      p.reparseList.push(this.wrapInJSDocNamespace(fullName, typeAlias, false));
      return true;
    }
    if (tag instanceof JSDocImportTag) {
      const tagImportClause = tag.importClause;
      if (tagImportClause === undefined) return false;
      const importClause = tagImportClause.deepClone();
      this.finishClone(importClause);
      p.reparsedClones.push(importClause);
      importClause.phaseModifier = SyntaxKind.TypeKeyword;
      const moduleSpecifier = this.addDeepCloneReparse(tag.moduleSpecifier);
      const tagAttributes = tag.attributes;
      let attributes: ImportAttributes | undefined;
      if (tagAttributes !== undefined) {
        const copy = tagAttributes.deepClone();
        this.finishClone(copy);
        p.reparsedClones.push(copy);
        attributes = copy;
      }
      const importDeclaration = new ImportDeclaration(
        SyntaxKind.JSImportDeclaration,
        undefined,
        importClause,
        moduleSpecifier,
        attributes,
      );
      this.finishReparsedNode(importDeclaration, tag);
      p.reparseList.push(importDeclaration);
      return true;
    }
    if (tag instanceof JSDocOverloadTag) {
      // Overload signatures only for functions, methods and constructors outside object literals.
      if (
        (parent.kind === SyntaxKind.FunctionDeclaration ||
          parent.kind === SyntaxKind.MethodDeclaration ||
          parent.kind === SyntaxKind.Constructor) &&
        !p.inObjectLiteralMembers()
      )
        p.reparseList.push(this.reparseJSDocSignature(tag.typeExpression, parent, jsDoc, tag, getModifiers(parent)));
      return true;
    }
    return false;
  }

  attachReparsedJSDoc(node: Node, jsDoc: Node): boolean {
    const docs: Node[] = [];
    docs.push(jsDoc);
    node.jsDoc = docs;
    this.p.jsDocInfos.push(node);
    node.flags |= NodeFlags.HasJSDoc;
    return true;
  }

  cloneTypeAliasName(name: Node): Identifier {
    if (!(name instanceof Identifier)) throw new Error('Expected an identifier for a JSDoc type alias name');
    return this.addDeepCloneReparseIdentifier(name);
  }

  reparseJSDocSignature(
    jsSignature: Node,
    fun: Node,
    jsDoc: JSDoc,
    tag: Node,
    modifiers: ModifierList | undefined,
  ): Node {
    const p = this.p;
    const clonedModifiers = this.cloneModifiers(modifiers);
    // The name, then the type parameters, then the parameters, as tsgo creates them.
    let functionName: Identifier | undefined;
    let methodName: Node | undefined;
    if (fun instanceof FunctionDeclaration) {
      const name = fun.name;
      if (name !== undefined) {
        this.checkNonIdentifierName(name);
        functionName = name.deepClone();
        this.finishClone(functionName);
      }
    } else if (fun instanceof MethodDeclaration) {
      methodName = this.deepCloneReparse(this.checkNonIdentifierName(fun.name));
    } else if (fun.kind !== SyntaxKind.Constructor && fun.kind !== SyntaxKind.JSDocCallbackTag) {
      throw new Error('Unexpected kind ' + fun.kind);
    }
    const typeParameters =
      tag.kind !== SyntaxKind.JSDocCallbackTag ? this.gatherTypeParameters(jsDoc, false) : undefined;
    const parameters: Node[] = [];
    const signatureParameters = jsSignature instanceof JSDocSignature ? jsSignature.parameters : undefined;
    if (signatureParameters !== undefined) {
      const params = signatureParameters.nodes;
      for (let pi = 0; pi < params.length; pi++) {
        const param = params[pi]!;
        let parameter: ParameterDeclaration;
        if (param instanceof JSDocThisTag) {
          const thisIdent = new Identifier('this');
          thisIdent.pos = param.pos;
          thisIdent.end = param.end;
          thisIdent.flags = p.contextFlags | NodeFlags.Reparsed;
          const type = this.addDeepCloneReparse(getType(param.typeExpression)!);
          parameter = new ParameterDeclaration(undefined, undefined, thisIdent, undefined, type, undefined);
        } else if (param instanceof JSDocParameterOrPropertyTag) {
          // Sub-properties like `@param x.y` describe a parameter's properties, not parameters.
          if (param.name instanceof QualifiedName) continue;
          let dotDotDotToken: Token | undefined;
          let paramType: TypeNode | undefined;
          const typeExpression = param.typeExpression;
          if (typeExpression !== undefined) {
            const type = getType(typeExpression)!;
            if (type instanceof JSDocVariadicType) {
              dotDotDotToken = new Token(SyntaxKind.DotDotDotToken);
              dotDotDotToken.pos = param.pos;
              dotDotDotToken.end = param.end;
              dotDotDotToken.flags = p.contextFlags | NodeFlags.Reparsed;
              paramType = this.reparseJSDocTypeLiteral(type.type);
            } else {
              paramType = this.reparseJSDocTypeLiteral(type);
            }
          }
          let name: Node = param.name;
          if (name instanceof Identifier && !isValidIdentifier(name.text)) {
            // Replace invalid characters with `_`, or use `_N` for an empty name, for a valid parameter name.
            name = this.addTransformedReparse(new Identifier(sanitizeIdentifier(name.text, pi)), name);
          } else {
            name = this.addDeepCloneReparse(name);
          }
          parameter = new ParameterDeclaration(
            undefined,
            dotDotDotToken,
            name,
            this.makeQuestionIfOptional(param),
            paramType,
            undefined,
          );
        } else {
          continue;
        }
        this.finishReparsedNode(parameter, param);
        parameters.push(parameter);
        this.reparseJSDocComment(parameter, param);
      }
    }
    const parameterList = new NodeList(
      signatureParameters !== undefined ? signatureParameters.pos : -1,
      signatureParameters !== undefined ? signatureParameters.end : -1,
      parameters,
    );
    let returnType: Node | undefined;
    const returnTag = getType(jsSignature);
    if (returnTag !== undefined) {
      const returnTypeExpression = getTypeExpression(returnTag);
      if (returnTypeExpression !== undefined) returnType = this.addDeepCloneReparse(getType(returnTypeExpression)!);
    }
    let signature: Node;
    if (fun instanceof FunctionDeclaration)
      signature = new FunctionDeclaration(
        clonedModifiers,
        undefined,
        functionName,
        typeParameters,
        parameterList,
        returnType,
        undefined,
        undefined,
      );
    else if (fun instanceof MethodDeclaration)
      signature = new MethodDeclaration(
        clonedModifiers,
        undefined,
        methodName!,
        undefined,
        typeParameters,
        parameterList,
        returnType,
        undefined,
        undefined,
      );
    else if (fun instanceof ConstructorDeclaration)
      signature = new ConstructorDeclaration(
        clonedModifiers,
        typeParameters,
        parameterList,
        returnType,
        undefined,
        undefined,
      );
    else
      signature = new FunctionTypeNode(
        undefined,
        parameterList,
        returnType !== undefined ? returnType : new KeywordTypeNode(SyntaxKind.AnyKeyword),
      );
    const location = tag instanceof JSDocOverloadTag ? tag.tagName : jsSignature;
    this.finishReparsedNode(signature, location);
    return signature;
  }

  reparseJSDocTypeLiteral(type: Node): Node {
    if (type instanceof JSDocTypeLiteral) {
      const properties: Node[] = [];
      const tags = type.jsdocPropertyTags;
      if (tags !== undefined)
        for (const tag of tags) {
          if (tag instanceof JSDocParameterOrPropertyTag) properties.push(this.reparseJSDocProperty(tag));
        }
      let result: Node = new TypeLiteralNode(this.p.newNodeList(type.pos, type.end, properties));
      if (type.isArrayType) {
        this.finishReparsedNode(result, type);
        result = new ArrayTypeNode(result);
      }
      this.finishReparsedNode(result, type);
      return result;
    }
    return this.addDeepCloneReparse(type);
  }

  reparseJSDocProperty(prop: JSDocParameterOrPropertyTag): Node {
    let name: Node = prop.name;
    if (name instanceof QualifiedName) name = name.right;
    if (name instanceof Identifier && !isValidIdentifier(name.text))
      name = this.addTransformedReparse(new StringLiteral(name.text, TokenFlags.None), name);
    else name = this.addDeepCloneReparse(name);
    const questionToken = this.makeQuestionIfOptional(prop);
    const propertyType =
      prop.typeExpression !== undefined ? this.reparseJSDocTypeLiteral(getType(prop.typeExpression)!) : undefined;
    const property = new PropertySignatureDeclaration(undefined, name, questionToken, propertyType, undefined);
    this.finishReparsedNode(property, prop);
    this.reparseJSDocComment(property, prop);
    return property;
  }

  /** Copies a tag's comment to a JSDoc node for its reparsed node. */
  reparseJSDocComment(node: Node, tag: Node): boolean {
    const comment = getComment(tag);
    if (comment === undefined) return false;
    const nodes: Node[] = [];
    for (const c of comment.nodes) nodes.push(this.deepCloneReparse(c));
    const propJSDoc = new JSDoc(new NodeList(comment.pos, comment.end, nodes), undefined);
    this.finishReparsedNode(propJSDoc, tag);
    propJSDoc.parent = node;
    const docs: Node[] = [];
    docs.push(propJSDoc);
    node.jsDoc = docs;
    this.p.jsDocInfos.push(node);
    node.flags |= NodeFlags.HasJSDoc;
    return true;
  }

  /** The type parameters of the `@template` tags; for non-typedefs, none if the comment has a @typedef or @callback. */
  gatherTypeParameters(j: JSDoc, typedefOrCallback: boolean): NodeList | undefined {
    const typeParameters: Node[] = [];
    let pos = -1;
    let endPos = -1;
    let firstTemplate = true;
    const tags = j.tags;
    if (tags === undefined) return undefined;
    for (const tag of tags.nodes) {
      // With a @typedef or @callback, @template declares the defined type's type parameters.
      if (!typedefOrCallback && (tag.kind === SyntaxKind.JSDocTypedefTag || tag.kind === SyntaxKind.JSDocCallbackTag))
        return undefined;
      if (!(tag instanceof JSDocTemplateTag)) continue;
      if (firstTemplate) {
        pos = tag.pos;
        firstTemplate = false;
      }
      endPos = tag.end;
      const constraint = tag.constraint;
      let firstTypeParameter = true;
      for (const tp of tag.typeParameters.nodes) {
        let reparse: Node;
        if (constraint !== undefined && firstTypeParameter && tp instanceof TypeParameterDeclaration) {
          const modifiers = this.cloneModifiers(tp.modifiers);
          this.checkNonIdentifierName(tp.name);
          const name = this.addDeepCloneReparseIdentifier(tp.name);
          const constraintType = this.addDeepCloneReparse(getType(constraint)!);
          const tpDefault = tp.defaultType;
          const defaultType = tpDefault !== undefined ? this.addDeepCloneReparse(tpDefault) : undefined;
          reparse = new TypeParameterDeclaration(modifiers, name, constraintType, undefined, defaultType);
          this.finishReparsedNode(reparse, tp);
        } else {
          reparse = this.addDeepCloneReparse(tp);
        }
        typeParameters.push(reparse);
        firstTypeParameter = false;
      }
    }
    return typeParameters.length === 0 ? undefined : this.p.newNodeList(pos, endPos, typeParameters);
  }

  reparseHosted(tag: Node, parent: Node, jsDoc: JSDoc): boolean {
    switch (tag.kind) {
      case SyntaxKind.JSDocTypeTag:
        return this.reparseTypeTag(tag, parent);
      case SyntaxKind.JSDocSatisfiesTag:
        if (tag instanceof JSDocSatisfiesTag) this.reparseSatisfiesTag(tag, parent);
        return true;
      case SyntaxKind.JSDocTemplateTag: {
        const fun = getFunctionLikeHost(parent);
        if (fun !== undefined) {
          if (getTypeParameters(fun) === undefined && getFullSignature(fun) === undefined) {
            setTypeParameters(fun, this.gatherTypeParameters(jsDoc, false));
            this.finishMutatedNode(fun);
          }
        } else if (parent.kind === SyntaxKind.ClassDeclaration || parent.kind === SyntaxKind.ClassExpression) {
          if (getClassTypeParameters(parent) === undefined) {
            setClassTypeParameters(parent, this.gatherTypeParameters(jsDoc, false));
            this.finishMutatedNode(parent);
          }
        }
        return true;
      }
      case SyntaxKind.JSDocParameterTag: {
        const fun = getFunctionLikeHost(parent);
        if (fun !== undefined && getFullSignature(fun) === undefined && tag instanceof JSDocParameterOrPropertyTag) {
          const param = findMatchingParameter(fun, tag, jsDoc);
          if (param !== undefined) {
            const typeExpression = tag.typeExpression;
            if (param.type === undefined && typeExpression !== undefined)
              param.type = this.reparseJSDocTypeLiteral(getType(typeExpression)!);
            if (param.questionToken === undefined) {
              const question = this.makeQuestionIfOptional(tag);
              if (question !== undefined) param.questionToken = question;
            }
            this.finishMutatedNode(param);
          }
        }
        return true;
      }
      case SyntaxKind.JSDocThisTag: {
        const fun = getFunctionLikeHost(parent);
        if (fun !== undefined && tag instanceof JSDocThisTag) {
          const parameters = getParameters(fun);
          const params = parameters !== undefined ? parameters.nodes : [];
          const firstName = params.length > 0 ? getName(params[0]!) : undefined;
          if (
            params.length === 0 ||
            (firstName !== undefined &&
              firstName.kind !== SyntaxKind.ThisKeyword &&
              !(firstName instanceof Identifier && firstName.text === 'this'))
          ) {
            // tsgo gives the `this` name no location.
            const thisParam = new ParameterDeclaration(
              undefined,
              undefined,
              new Identifier('this'),
              undefined,
              undefined,
              undefined,
            );
            thisParam.type = this.addDeepCloneReparse(getType(tag.typeExpression)!);
            this.finishReparsedNode(thisParam, tag.tagName);
            const newParams: Node[] = [thisParam];
            for (const param of params) newParams.push(param);
            setParameters(
              fun,
              this.p.newNodeList(
                parameters !== undefined ? parameters.pos : -1,
                parameters !== undefined ? parameters.end : -1,
                newParams,
              ),
            );
            this.finishMutatedNode(fun);
          }
        }
        return true;
      }
      case SyntaxKind.JSDocReturnTag: {
        const fun = getFunctionLikeHost(parent);
        if (fun !== undefined && getFullSignature(fun) === undefined) {
          const typeExpression = getTypeExpression(tag);
          if (getType(fun) === undefined && typeExpression !== undefined) {
            setType(fun, this.addDeepCloneReparse(getType(typeExpression)!));
            this.finishMutatedNode(fun);
          }
        }
        return true;
      }
      case SyntaxKind.JSDocReadonlyTag:
      case SyntaxKind.JSDocPrivateTag:
      case SyntaxKind.JSDocPublicTag:
      case SyntaxKind.JSDocProtectedTag:
      case SyntaxKind.JSDocOverrideTag:
        return this.reparseModifierTag(tag, parent);
      case SyntaxKind.JSDocImplementsTag:
        if (tag instanceof JSDocImplementsTag) this.reparseImplementsTag(tag, parent);
        return true;
      case SyntaxKind.JSDocAugmentsTag:
        if (tag instanceof JSDocAugmentsTag) this.reparseAugmentsTag(tag, parent);
        return true;
    }
    return false;
  }

  reparseTypeTag(tag: Node, parent: Node): boolean {
    const typeExpression = getTypeExpression(tag);
    switch (parent.kind) {
      case SyntaxKind.VariableStatement:
        if (parent instanceof VariableStatement)
          for (const declaration of parent.declarationList.declarations.nodes)
            if (
              declaration instanceof VariableDeclaration &&
              declaration.type === undefined &&
              typeExpression !== undefined
            ) {
              declaration.type = this.addDeepCloneReparse(getType(typeExpression)!);
              this.finishMutatedNode(declaration);
              return true;
            }
        break;
      case SyntaxKind.VariableDeclaration:
      case SyntaxKind.ExportAssignment:
      case SyntaxKind.PropertyDeclaration:
      case SyntaxKind.PropertyAssignment:
      case SyntaxKind.ShorthandPropertyAssignment:
      case SyntaxKind.GetAccessor:
        if (getType(parent) === undefined && typeExpression !== undefined) {
          setType(parent, this.addDeepCloneReparse(getType(typeExpression)!));
          this.finishMutatedNode(parent);
          return true;
        }
        break;
      case SyntaxKind.Parameter:
        if (getType(parent) === undefined && typeExpression !== undefined) {
          setType(parent, this.reparseJSDocTypeLiteral(getType(typeExpression)!));
          this.finishMutatedNode(parent);
          return true;
        }
        break;
      case SyntaxKind.ExpressionStatement:
        if (parent instanceof ExpressionStatement) {
          const bin = parent.expression;
          if (bin instanceof BinaryExpression && isAssignmentDeclaration(bin) && typeExpression !== undefined) {
            bin.type = this.addDeepCloneReparse(getType(typeExpression)!);
            this.finishMutatedNode(bin);
            return true;
          }
        }
        break;
      case SyntaxKind.ReturnStatement:
      case SyntaxKind.ParenthesizedExpression: {
        const expression = getExpressionOfReturnOrParenthesized(parent);
        if (expression !== undefined && typeExpression !== undefined) {
          setExpression(parent, this.makeNewCast(this.addDeepCloneReparse(getType(typeExpression)!), expression, true));
          this.finishMutatedNode(parent);
          return true;
        }
        break;
      }
    }
    const fun = getFunctionLikeHost(parent);
    if (fun !== undefined) {
      const parameters = getParameters(fun);
      let noTypedParams = true;
      if (parameters !== undefined)
        for (const param of parameters.nodes)
          if (getType(param) !== undefined) {
            noTypedParams = false;
            break;
          }
      if (
        getTypeParameters(fun) === undefined &&
        getType(fun) === undefined &&
        noTypedParams &&
        typeExpression !== undefined
      ) {
        setFullSignature(fun, this.addDeepCloneReparse(getType(typeExpression)!));
        this.finishMutatedNode(fun);
      }
    }
    return true;
  }

  reparseSatisfiesTag(tag: JSDocSatisfiesTag, parent: Node): boolean {
    const typeExpression = tag.typeExpression;
    if (parent instanceof VariableStatement) {
      for (const declaration of parent.declarationList.declarations.nodes)
        if (declaration instanceof VariableDeclaration) {
          const initializer = declaration.initializer;
          if (initializer === undefined) continue;
          declaration.initializer = this.makeNewCast(
            this.addDeepCloneReparse(getType(typeExpression)!),
            initializer,
            false,
          );
          this.finishMutatedNode(declaration);
          break;
        }
    } else if (
      parent.kind === SyntaxKind.VariableDeclaration ||
      parent.kind === SyntaxKind.PropertyDeclaration ||
      parent.kind === SyntaxKind.PropertyAssignment
    ) {
      const initializer = getInitializer(parent);
      if (initializer !== undefined) {
        setInitializer(
          parent,
          this.makeNewCast(this.addDeepCloneReparse(getType(typeExpression)!), initializer, false),
        );
        this.finishMutatedNode(parent);
      }
    } else if (parent instanceof ShorthandPropertyAssignment) {
      const initializer = parent.objectAssignmentInitializer;
      if (initializer !== undefined) {
        parent.objectAssignmentInitializer = this.makeNewCast(
          this.addDeepCloneReparse(getType(typeExpression)!),
          initializer,
          false,
        );
        this.finishMutatedNode(parent);
      }
    } else if (
      parent.kind === SyntaxKind.ReturnStatement ||
      parent.kind === SyntaxKind.ParenthesizedExpression ||
      parent.kind === SyntaxKind.ExportAssignment
    ) {
      const expression = getExpressionOfReturnOrParenthesized(parent);
      if (expression !== undefined) {
        setExpression(parent, this.makeNewCast(this.addDeepCloneReparse(getType(typeExpression)!), expression, false));
        this.finishMutatedNode(parent);
      }
    } else if (parent instanceof ExpressionStatement) {
      const bin = parent.expression;
      if (bin instanceof BinaryExpression && isAssignmentDeclaration(bin)) {
        bin.right = this.makeNewCast(this.addDeepCloneReparse(getType(typeExpression)!), bin.right, false);
        this.finishMutatedNode(bin);
      }
    }
    return true;
  }

  reparseModifierTag(tag: Node, parent: Node): boolean {
    if (parent instanceof ExpressionStatement) parent = parent.expression;
    switch (parent.kind) {
      case SyntaxKind.MethodDeclaration:
      case SyntaxKind.GetAccessor:
      case SyntaxKind.SetAccessor:
        // In object literals these aren't class members: reparsed modifiers would cause spurious grammar errors.
        if (this.p.inObjectLiteralMembers()) return false;
        break;
      case SyntaxKind.PropertyDeclaration:
      case SyntaxKind.Constructor:
      case SyntaxKind.BinaryExpression:
        break;
      default:
        return false;
    }
    let keyword: SyntaxKind;
    switch (tag.kind) {
      case SyntaxKind.JSDocReadonlyTag:
        keyword = SyntaxKind.ReadonlyKeyword;
        break;
      case SyntaxKind.JSDocPrivateTag:
        keyword = SyntaxKind.PrivateKeyword;
        break;
      case SyntaxKind.JSDocPublicTag:
        keyword = SyntaxKind.PublicKeyword;
        break;
      case SyntaxKind.JSDocProtectedTag:
        keyword = SyntaxKind.ProtectedKeyword;
        break;
      default:
        keyword = SyntaxKind.OverrideKeyword;
    }
    const modifier = new Token(keyword);
    modifier.pos = tag.pos;
    modifier.end = tag.end;
    modifier.flags = this.p.contextFlags | NodeFlags.Reparsed;
    const existing = getModifiers(parent);
    let list: ModifierList;
    if (existing === undefined) {
      list = this.p.newModifierList(tag.pos, tag.end, [modifier]);
    } else {
      const nodes = existing.nodes.slice();
      nodes.push(modifier);
      list = this.p.newModifierList(existing.pos, existing.end, nodes);
    }
    setModifiers(parent, list);
    this.finishMutatedNode(parent);
    return true;
  }

  reparseImplementsTag(tag: JSDocImplementsTag, parent: Node): boolean {
    if (parent.kind !== SyntaxKind.ClassDeclaration && parent.kind !== SyntaxKind.ClassExpression) return false;
    const className = tag.className;
    const heritageClauses = getHeritageClauses(parent);
    if (heritageClauses !== undefined) {
      for (const clause of heritageClauses.nodes)
        if (clause instanceof HeritageClause && clause.token === SyntaxKind.ImplementsKeyword) {
          clause.types.nodes.push(this.addDeepCloneReparse(className));
          this.finishMutatedNode(clause);
          return true;
        }
    }
    const typesList = this.p.newNodeList(className.pos, className.end, [this.addDeepCloneReparse(className)]);
    const heritageClause = new HeritageClause(SyntaxKind.ImplementsKeyword, typesList);
    this.finishReparsedNode(heritageClause, className);
    if (heritageClauses === undefined)
      setHeritageClauses(parent, this.p.newNodeList(className.pos, className.end, [heritageClause]));
    else heritageClauses.nodes.push(heritageClause);
    this.finishMutatedNode(parent);
    return true;
  }

  reparseAugmentsTag(tag: JSDocAugmentsTag, parent: Node): boolean {
    const heritageClauses = getHeritageClauses(parent);
    if (heritageClauses === undefined) return false;
    for (const clause of heritageClauses.nodes) {
      if (!(clause instanceof HeritageClause) || clause.token !== SyntaxKind.ExtendsKeyword) continue;
      if (clause.types.nodes.length !== 1) return false;
      const target = clause.types.nodes[0]!;
      const source = tag.className;
      if (
        target instanceof ExpressionWithTypeArguments &&
        hasSamePropertyAccessName(target.expression, source.expression) &&
        target.typeArguments === undefined &&
        source.typeArguments !== undefined
      ) {
        const newArguments: Node[] = [];
        for (const arg of source.typeArguments.nodes) newArguments.push(this.addDeepCloneReparse(arg));
        target.typeArguments = this.p.newNodeList(source.typeArguments.pos, source.typeArguments.end, newArguments);
        this.finishMutatedNode(target);
      }
      return true;
    }
    return false;
  }

  makeQuestionIfOptional(parameter: JSDocParameterOrPropertyTag): Token | undefined {
    const typeExpression = parameter.typeExpression;
    if (
      parameter.isBracketed ||
      (typeExpression !== undefined && getType(typeExpression) instanceof JSDocOptionalType)
    ) {
      const questionToken = new Token(SyntaxKind.QuestionToken);
      questionToken.pos = parameter.pos;
      questionToken.end = parameter.end;
      questionToken.flags = this.p.contextFlags | NodeFlags.Reparsed;
      return questionToken;
    }
    return undefined;
  }

  makeNewCast(type: TypeNode, e: Node, isAssertion: boolean): Node {
    const cast: Node = isAssertion ? new AsExpression(e, type) : new SatisfiesExpression(e, type);
    this.p.finishNodeWithEnd(cast, e.pos, e.end);
    return cast;
  }

  createExportModifier(locationNode: Node): ModifierList {
    const exportModifier = new Token(SyntaxKind.ExportKeyword);
    exportModifier.pos = locationNode.pos;
    exportModifier.end = locationNode.end;
    exportModifier.flags = this.p.contextFlags | NodeFlags.Reparsed;
    return this.p.newModifierList(locationNode.pos, locationNode.end, [exportModifier]);
  }

  /** The innermost identifier of a JSDoc namespace chain: `C` for `A.B.C`. */
  getInnermostNameOfJSDocNamespace(fullName: Node | undefined): Node | undefined {
    if (fullName === undefined) return undefined;
    while (fullName instanceof ModuleDeclaration) {
      const body: Node | undefined = fullName.body;
      if (body === undefined) return fullName.name;
      fullName = body;
    }
    return fullName;
  }

  /** Wraps `statement` in namespaces for a dotted JSDoc name: `A.B.C` gives `namespace A { namespace B { … } }`. */
  wrapInJSDocNamespace(fullName: Node | undefined, statement: Node, nested: boolean): Node {
    if (!(fullName instanceof ModuleDeclaration)) return statement;
    // Inner namespaces are exported for dotted access; the binder treats the outermost one as
    // exported in module files.
    const wrapped = this.wrapInJSDocNamespace(fullName.body, statement, true);
    const block = new ModuleBlock(this.p.newNodeList(fullName.pos, fullName.end, [wrapped]));
    this.finishReparsedNode(block, fullName);
    const modifiers = nested ? this.createExportModifier(fullName) : undefined;
    const result = new ModuleDeclaration(
      modifiers,
      SyntaxKind.NamespaceKeyword,
      this.addDeepCloneReparse(fullName.name),
      block,
    );
    this.finishReparsedNode(result, fullName);
    this.p.reparsedClones.push(result);
    return result;
  }
}

/** The JSDoc parameter tag's matching parameter, by name or by position. */
function findMatchingParameter(
  fun: Node,
  parameterTag: JSDocParameterOrPropertyTag,
  jsDoc: JSDoc,
): ParameterDeclaration | undefined {
  let tagIndex = -1;
  let paramCount = -1;
  if (jsDoc.tags !== undefined)
    for (const tag of jsDoc.tags.nodes)
      if (tag.kind === SyntaxKind.JSDocParameterTag) {
        paramCount++;
        if (tag === parameterTag) {
          tagIndex = paramCount;
          break;
        }
      }
  const parameters = getParameters(fun);
  if (parameters === undefined) return undefined;
  const params = parameters.nodes;
  const tagName = parameterTag.name;
  let parameterIndex = 0;
  for (const node of params) {
    if (node instanceof ParameterDeclaration && parameterMatches(node, tagName, parameterIndex === tagIndex))
      return node;
    parameterIndex++;
  }
  return undefined;
}

function parameterMatches(parameter: ParameterDeclaration, tagName: Node, isTagIndex: boolean): boolean {
  const name = parameter.name;
  if (name instanceof Identifier)
    return tagName instanceof Identifier && (name.text === tagName.text || (isTagIndex && tagName.text.length === 0));
  return isTagIndex;
}

/** The function documented by a JSDoc host: the host itself, or a function in its initializer or expression. */
function getFunctionLikeHost(host: Node): Node | undefined {
  let fun: Node | undefined = host;
  if (host instanceof VariableStatement) {
    const nodes = host.declarationList.declarations.nodes;
    if (nodes.length !== 0) {
      const first = nodes[0]!;
      fun = first instanceof VariableDeclaration ? first.initializer : undefined;
    }
  } else if (host.kind === SyntaxKind.PropertyAssignment || host.kind === SyntaxKind.PropertyDeclaration) {
    fun = getInitializer(host);
  } else if (host instanceof ExportAssignment) {
    fun = host.expression;
  } else if (host instanceof ReturnStatement) {
    fun = host.expression;
  } else if (host instanceof ExpressionStatement) {
    fun = getRightMostAssignedExpression(host.expression);
  }
  while (fun instanceof SatisfiesExpression) fun = fun.expression;
  return isFunctionLike(fun) ? fun : undefined;
}

function getRightMostAssignedExpression(node: Node): Node {
  while (
    node instanceof BinaryExpression &&
    (node.operatorToken.kind === SyntaxKind.EqualsToken || isAssignmentOperator(node.operatorToken.kind)) &&
    isLeftHandSideExpression(node.left)
  )
    node = node.right;
  return node;
}

function getExpressionOfReturnOrParenthesized(node: Node): Node | undefined {
  if (node instanceof ReturnStatement || node instanceof ParenthesizedExpression || node instanceof ExportAssignment)
    return node.expression;
  return undefined;
}

function hasSamePropertyAccessName(node1: Node, node2: Node): boolean {
  if (node1 instanceof Identifier && node2 instanceof Identifier) return node1.text === node2.text;
  if (node1 instanceof PropertyAccessExpression && node2 instanceof PropertyAccessExpression) {
    return getText(node1.name) === getText(node2.name) && hasSamePropertyAccessName(node1.expression, node2.expression);
  }
  return false;
}

// Assignment declarations (tsgo's GetAssignmentDeclarationKind(node) != JSDeclarationKindNone).

function isIdentifierNamed(node: Node, text: string): boolean {
  return node instanceof Identifier && node.text === text;
}

function skipParentheses(node: Node): Node {
  while (node instanceof ParenthesizedExpression) node = node.expression;
  return node;
}

function isStringOrNumericLiteralLike(node: Node): boolean {
  return isStringLiteralLike(node) || node instanceof NumericLiteral;
}

function getAccessExpression(node: Node): Node | undefined {
  if (node instanceof PropertyAccessExpression || node instanceof ElementAccessExpression) return node.expression;
  return undefined;
}

/** The name of a property access with an identifier name, or an element access with a literal argument. */
function getElementOrPropertyAccessName(node: Node): Node | undefined {
  if (node instanceof PropertyAccessExpression) return node.name instanceof Identifier ? node.name : undefined;
  if (node instanceof ElementAccessExpression) {
    const argument = skipParentheses(node.argumentExpression);
    return isStringOrNumericLiteralLike(argument) ? argument : undefined;
  }
  return undefined;
}

function isModuleExportsAccessExpression(node: Node): boolean {
  const expression = getAccessExpression(node);
  if (expression !== undefined && isIdentifierNamed(expression, 'module')) {
    const name = getElementOrPropertyAccessName(node);
    return name !== undefined && getText(name) === 'exports';
  }
  return false;
}

function isEntityNameExpression(node: Node, allowJS: boolean): boolean {
  if (node instanceof Identifier) return true;
  if (node instanceof PropertyAccessExpression)
    return node.name instanceof Identifier && isEntityNameExpression(node.expression, allowJS);
  if (!allowJS) return false;
  if (node.kind === SyntaxKind.ThisKeyword) return true;
  return (
    node instanceof ElementAccessExpression &&
    isStringOrNumericLiteralLike(node.argumentExpression) &&
    isEntityNameExpression(node.expression, allowJS)
  );
}

function isBindableStaticAccessExpression(node: Node, excludeThisKeyword: boolean): boolean {
  if (node instanceof PropertyAccessExpression)
    return (
      (!excludeThisKeyword && node.expression.kind === SyntaxKind.ThisKeyword) ||
      (node.name instanceof Identifier && isBindableStaticNameExpression(node.expression, true))
    );
  return isBindableStaticElementAccessExpression(node, excludeThisKeyword);
}

function isBindableStaticElementAccessExpression(node: Node, excludeThisKeyword: boolean): boolean {
  return (
    node instanceof ElementAccessExpression &&
    isStringOrNumericLiteralLike(node.argumentExpression) &&
    ((!excludeThisKeyword && node.expression.kind === SyntaxKind.ThisKeyword) ||
      isEntityNameExpression(node.expression, false) ||
      isBindableStaticAccessExpression(node.expression, true))
  );
}

function isBindableStaticNameExpression(node: Node, excludeThisKeyword: boolean): boolean {
  return isEntityNameExpression(node, false) || isBindableStaticAccessExpression(node, excludeThisKeyword);
}

function isAssignmentDeclaration(bin: BinaryExpression): boolean {
  const left = bin.left;
  if (bin.operatorToken.kind !== SyntaxKind.EqualsToken) return false;
  const leftExpression = getAccessExpression(left);
  if (leftExpression === undefined) return false;
  const inJS = isInJSFile(left);
  if (inJS) {
    if (isModuleExportsAccessExpression(left) && !isIdentifierNamed(bin.right, 'exports')) return true;
    if (
      (isModuleExportsAccessExpression(leftExpression) || isIdentifierNamed(leftExpression, 'exports')) &&
      getElementOrPropertyAccessName(left) !== undefined
    )
      return true;
    if (leftExpression.kind === SyntaxKind.ThisKeyword) return true;
  }
  if (left instanceof PropertyAccessExpression)
    return isEntityNameExpression(left.expression, inJS) && left.name instanceof Identifier;
  return left instanceof ElementAccessExpression && isEntityNameExpression(left.expression, inJS);
}

// Fields of function-like and other hosts.

function getFullSignature(node: Node): Node | undefined {
  if (
    node instanceof FunctionDeclaration ||
    node instanceof MethodDeclaration ||
    node instanceof ConstructorDeclaration ||
    node instanceof GetAccessorDeclaration ||
    node instanceof SetAccessorDeclaration ||
    node instanceof FunctionExpression ||
    node instanceof ArrowFunction
  )
    return node.fullSignature;
  return undefined;
}

/** tsgo stores a full signature on every function-like node, but only these visit it. */
function setFullSignature(node: Node, value: Node): boolean {
  if (
    node instanceof FunctionDeclaration ||
    node instanceof MethodDeclaration ||
    node instanceof ConstructorDeclaration ||
    node instanceof GetAccessorDeclaration ||
    node instanceof SetAccessorDeclaration ||
    node instanceof FunctionExpression ||
    node instanceof ArrowFunction
  ) {
    node.fullSignature = value;
    return true;
  }
  return false;
}

function setTypeParameters(node: Node, value: NodeList | undefined): boolean {
  if (
    node instanceof FunctionDeclaration ||
    node instanceof MethodDeclaration ||
    node instanceof ConstructorDeclaration ||
    node instanceof GetAccessorDeclaration ||
    node instanceof SetAccessorDeclaration ||
    node instanceof FunctionExpression ||
    node instanceof ArrowFunction ||
    node instanceof MethodSignatureDeclaration ||
    node instanceof CallSignatureDeclaration ||
    node instanceof ConstructSignatureDeclaration ||
    node instanceof FunctionTypeNode ||
    node instanceof ConstructorTypeNode ||
    node instanceof JSDocSignature
  ) {
    node.typeParameters = value;
    return true;
  }
  return false;
}

function setParameters(node: Node, value: NodeList): boolean {
  if (
    node instanceof FunctionDeclaration ||
    node instanceof MethodDeclaration ||
    node instanceof ConstructorDeclaration ||
    node instanceof GetAccessorDeclaration ||
    node instanceof SetAccessorDeclaration ||
    node instanceof FunctionExpression ||
    node instanceof ArrowFunction ||
    node instanceof MethodSignatureDeclaration ||
    node instanceof CallSignatureDeclaration ||
    node instanceof ConstructSignatureDeclaration ||
    node instanceof IndexSignatureDeclaration ||
    node instanceof FunctionTypeNode ||
    node instanceof ConstructorTypeNode ||
    node instanceof JSDocSignature
  ) {
    node.parameters = value;
    return true;
  }
  return false;
}

function setType(node: Node, value: Node): boolean {
  if (
    node instanceof FunctionDeclaration ||
    node instanceof MethodDeclaration ||
    node instanceof ConstructorDeclaration ||
    node instanceof GetAccessorDeclaration ||
    node instanceof SetAccessorDeclaration ||
    node instanceof FunctionExpression ||
    node instanceof ArrowFunction ||
    node instanceof MethodSignatureDeclaration ||
    node instanceof CallSignatureDeclaration ||
    node instanceof ConstructSignatureDeclaration ||
    node instanceof IndexSignatureDeclaration ||
    node instanceof FunctionTypeNode ||
    node instanceof ConstructorTypeNode ||
    node instanceof JSDocSignature ||
    node instanceof VariableDeclaration ||
    node instanceof ExportAssignment ||
    node instanceof PropertyDeclaration ||
    node instanceof PropertyAssignment ||
    node instanceof ShorthandPropertyAssignment ||
    node instanceof ParameterDeclaration ||
    node instanceof BinaryExpression
  ) {
    node.type = value;
    return true;
  }
  return false;
}

function setExpression(node: Node, value: Node): boolean {
  if (node instanceof ReturnStatement || node instanceof ParenthesizedExpression || node instanceof ExportAssignment) {
    node.expression = value;
    return true;
  }
  return false;
}

function setModifiers(node: Node, value: ModifierList): boolean {
  if (
    node instanceof MethodDeclaration ||
    node instanceof GetAccessorDeclaration ||
    node instanceof SetAccessorDeclaration ||
    node instanceof PropertyDeclaration ||
    node instanceof ConstructorDeclaration ||
    node instanceof BinaryExpression
  ) {
    node.modifiers = value;
    return true;
  }
  return false;
}

function getInitializer(node: Node): Node | undefined {
  if (node instanceof VariableDeclaration || node instanceof PropertyDeclaration || node instanceof PropertyAssignment)
    return node.initializer;
  return undefined;
}

function setInitializer(node: Node, value: Node): boolean {
  if (
    node instanceof VariableDeclaration ||
    node instanceof PropertyDeclaration ||
    node instanceof PropertyAssignment
  ) {
    node.initializer = value;
    return true;
  }
  return false;
}

function getHeritageClauses(node: Node): NodeList | undefined {
  if (node instanceof ClassDeclaration || node instanceof ClassExpression) return node.heritageClauses;
  return undefined;
}

function setHeritageClauses(node: Node, value: NodeList): boolean {
  if (node instanceof ClassDeclaration || node instanceof ClassExpression) {
    node.heritageClauses = value;
    return true;
  }
  return false;
}

function getClassTypeParameters(node: Node): NodeList | undefined {
  if (node instanceof ClassDeclaration || node instanceof ClassExpression) return node.typeParameters;
  return undefined;
}

function setClassTypeParameters(node: Node, value: NodeList | undefined): boolean {
  if (node instanceof ClassDeclaration || node instanceof ClassExpression) {
    node.typeParameters = value;
    return true;
  }
  return false;
}

/** Whether `s` is a valid identifier: an identifier start followed by identifier parts. */
function isValidIdentifier(s: string): boolean {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length;) {
    const ch = s.codePointAt(i)!;
    if (i === 0 ? !isIdentifierStart(ch) : !isIdentifierPart(ch)) return false;
    i += ch > 0xffff ? 2 : 1;
  }
  return true;
}

/** `s` with invalid identifier characters replaced by `_`, or `_<index>` if empty. */
function sanitizeIdentifier(s: string, index: number): string {
  let result = '';
  for (let i = 0; i < s.length;) {
    const ch = s.codePointAt(i)!;
    const valid = i === 0 ? isIdentifierStart(ch) : isIdentifierPart(ch);
    result += valid ? String.fromCodePoint(ch) : '_';
    i += ch > 0xffff ? 2 : 1;
  }
  return result.length === 0 ? '_' + index : result;
}
