import { extname } from 'node:path';
import type { QualityFunction } from '@orquestra/shared';
import ts from 'typescript';

export interface ImportRef {
  specifier: string;
  typeOnly: boolean;
}

export interface SourceMetrics {
  loc: number;
  functions: Omit<QualityFunction, 'path'>[];
  imports: ImportRef[];
}

type FunctionNode =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

function scriptKindFor(fileName: string): ts.ScriptKind {
  const ext = extname(fileName).toLowerCase();
  if (ext === '.tsx') return ts.ScriptKind.TSX;
  if (ext === '.jsx') return ts.ScriptKind.JSX;
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** Conta linhas que contêm tokens reais a partir da AST já parseada (lida com `${...}` e JSX). */
function countCodeLines(root: ts.Node, sourceFile: ts.SourceFile): number {
  const codeLines = new Set<number>();

  const walkTokens = (node: ts.Node): void => {
    if (ts.isJSDoc(node)) return;
    const children = node.getChildren(sourceFile);
    if (children.length === 0) {
      if (node.kind === ts.SyntaxKind.EndOfFileToken) return;
      if (node.getWidth(sourceFile) <= 0) return;

      const start = node.getStart(sourceFile);
      const startLine = sourceFile.getLineAndCharacterOfPosition(start).line + 1;
      if (ts.isJsxText(node)) {
        if (node.containsOnlyTriviaWhiteSpaces) return;
        const parts = node.getText(sourceFile).split(/\r?\n/);
        for (let i = 0; i < parts.length; i++) {
          if (parts[i]!.trim().length > 0) codeLines.add(startLine + i);
        }
        return;
      }

      const end = Math.max(start, node.getEnd() - 1);
      const endLine = sourceFile.getLineAndCharacterOfPosition(end).line + 1;
      for (let line = startLine; line <= endLine; line++) codeLines.add(line);
      return;
    }

    for (const child of children) walkTokens(child);
  };

  walkTokens(root);
  return codeLines.size;
}

function isFunctionNode(node: ts.Node): node is FunctionNode {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function propertyNameText(name: ts.PropertyName, sourceFile: ts.SourceFile): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name)) {
    return name.text;
  }
  return name.getText(sourceFile);
}

function resolveFunctionName(node: FunctionNode, sourceFile: ts.SourceFile): string {
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if ('name' in node && node.name) {
    if (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name)) return node.name.text;
    return propertyNameText(node.name, sourceFile);
  }
  const parent = node.parent;
  if (parent) {
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) return propertyNameText(parent.name, sourceFile);
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === node) {
      if (ts.isIdentifier(parent.left)) return parent.left.text;
      if (ts.isPropertyAccessExpression(parent.left)) return parent.left.name.text;
    }
  }
  return '(anônima)';
}

function isComplexityBinaryOp(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.AmpersandAmpersandToken ||
    kind === ts.SyntaxKind.BarBarToken ||
    kind === ts.SyntaxKind.QuestionQuestionToken
  );
}

function isLoopOrSwitch(node: ts.Node): boolean {
  return (
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isSwitchStatement(node)
  );
}

function measureFunction(node: FunctionNode, sourceFile: ts.SourceFile): Omit<QualityFunction, 'path'> {
  let complexity = 1;
  let maxDepth = 0;

  const visitBody = (current: ts.Node, depth: number): void => {
    if (isFunctionNode(current)) return;

    if (ts.isIfStatement(current)) {
      complexity++;
      const nextDepth = depth + 1;
      if (nextDepth > maxDepth) maxDepth = nextDepth;
      visitBody(current.expression, nextDepth);
      visitBody(current.thenStatement, nextDepth);
      if (current.elseStatement) {
        // O `else if` encadeado mantém o mesmo nível do `if` anterior.
        visitBody(current.elseStatement, ts.isIfStatement(current.elseStatement) ? depth : nextDepth);
      }
      return;
    }

    if (isLoopOrSwitch(current)) {
      if (!ts.isSwitchStatement(current)) complexity++;
      const nextDepth = depth + 1;
      if (nextDepth > maxDepth) maxDepth = nextDepth;
      ts.forEachChild(current, (child) => visitBody(child, nextDepth));
      return;
    }

    if (ts.isTryStatement(current)) {
      const nextDepth = depth + 1;
      if (nextDepth > maxDepth) maxDepth = nextDepth;
      visitBody(current.tryBlock, nextDepth);
      if (current.catchClause) visitBody(current.catchClause, depth);
      if (current.finallyBlock) visitBody(current.finallyBlock, nextDepth);
      return;
    }

    if (ts.isCatchClause(current)) {
      complexity++;
      const nextDepth = depth + 1;
      if (nextDepth > maxDepth) maxDepth = nextDepth;
      if (current.variableDeclaration) visitBody(current.variableDeclaration, nextDepth);
      visitBody(current.block, nextDepth);
      return;
    }

    if (ts.isConditionalExpression(current) || ts.isCaseClause(current)) {
      complexity++;
    } else if (ts.isBinaryExpression(current) && isComplexityBinaryOp(current.operatorToken.kind)) {
      complexity++;
    }

    ts.forEachChild(current, (child) => visitBody(child, depth));
  };

  for (const param of node.parameters) {
    if (param.initializer) visitBody(param.initializer, 0);
  }
  if (node.body) visitBody(node.body, 0);

  const start = node.getStart(sourceFile);
  const line = sourceFile.getLineAndCharacterOfPosition(start).line + 1;
  const loc = countCodeLines(node, sourceFile);

  return {
    line,
    name: resolveFunctionName(node, sourceFile),
    complexity,
    depth: maxDepth,
    loc,
  };
}

function isTypeOnlyImportClause(clause: ts.ImportClause | undefined): boolean {
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  if (clause.name) return false;
  const bindings = clause.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings) || bindings.elements.length === 0) return false;
  return bindings.elements.every((el) => el.isTypeOnly);
}

function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  if (!node.exportClause || !ts.isNamedExports(node.exportClause) || node.exportClause.elements.length === 0) {
    return false;
  }
  return node.exportClause.elements.every((el) => el.isTypeOnly);
}

/** Mede linhas de código, funções (complexidade ciclomática e aninhamento) e imports de um arquivo JS/TS. */
export function analyzeSource(fileName: string, text: string): SourceMetrics {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
  const loc = countCodeLines(sourceFile, sourceFile);
  const functions: Omit<QualityFunction, 'path'>[] = [];
  const imports: ImportRef[] = [];

  const walk = (node: ts.Node): void => {
    if (isFunctionNode(node) && node.body) {
      functions.push(measureFunction(node, sourceFile));
    } else if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push({ specifier: node.moduleSpecifier.text, typeOnly: isTypeOnlyImportClause(node.importClause) });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push({ specifier: node.moduleSpecifier.text, typeOnly: isTypeOnlyExport(node) });
    } else if (ts.isCallExpression(node) && node.arguments.length >= 1 && ts.isStringLiteral(node.arguments[0]!)) {
      const expr = node.expression;
      const isDynamicImport = expr.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(expr) && expr.text === 'require' && node.arguments.length === 1;
      if (isDynamicImport || isRequire) {
        imports.push({ specifier: node.arguments[0]!.text, typeOnly: false });
      }
    }
    ts.forEachChild(node, walk);
  };

  walk(sourceFile);
  return { loc, functions, imports };
}
