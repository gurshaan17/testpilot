/**
 * Shared ts-morph helpers for naming and describing function-like nodes.
 */
import path from 'node:path';
import {
  Node,
  type ArrowFunction,
  type FunctionDeclaration,
  type FunctionExpression,
  type SourceFile
} from 'ts-morph';

export interface Callable {
  node: Node;
  name: string;
  qualifiedName: string;
  file: string;
  startLine: number;
  endLine: number;
  isExported: boolean;
  signature: string;
  bodyText: string;
}

function bodyOf(node: Node): Node | undefined {
  const candidate = node as unknown as { getBody?: () => Node | undefined };
  return candidate.getBody?.();
}

function assignedName(node: Node): string | undefined {
  const parent = node.getParent();
  if (Node.isVariableDeclaration(parent) && parent.getInitializer() === node) {
    return parent.getName();
  }
  if (Node.isPropertyDeclaration(parent) && parent.getInitializer() === node) {
    return parent.getName();
  }
  return undefined;
}

function isAssignedFunction(node: Node): boolean {
  return (
    (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) &&
    assignedName(node) !== undefined
  );
}

export function isFunctionLike(node: Node): boolean {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node) ||
    Node.isConstructorDeclaration(node) ||
    Node.isArrowFunction(node) ||
    Node.isFunctionExpression(node)
  );
}

function nameOf(node: Node): string | undefined {
  if (
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node)
  ) {
    return node.getName();
  }
  if (Node.isConstructorDeclaration(node)) return 'constructor';
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
    return assignedName(node);
  }
  return undefined;
}

function classNameOf(node: Node): string | undefined {
  const classNode = node.getFirstAncestor((ancestor) => Node.isClassDeclaration(ancestor));
  return classNode?.getName();
}

function exportFlag(node: Node): boolean {
  if (Node.isFunctionDeclaration(node)) return node.hasExportKeyword();

  if (Node.isMethodDeclaration(node) || Node.isGetAccessorDeclaration(node) || Node.isSetAccessorDeclaration(node)) {
    const classNode = node.getFirstAncestor((ancestor) => Node.isClassDeclaration(ancestor));
    return classNode?.hasExportKeyword() ?? false;
  }

  const variable = node.getFirstAncestor((ancestor) => Node.isVariableDeclaration(ancestor));
  if (variable) {
    return variable.getVariableStatement()?.hasExportKeyword() ?? false;
  }

  const property = node.getFirstAncestor((ancestor) => Node.isPropertyDeclaration(ancestor));
  if (property) {
    const classNode = property.getFirstAncestor((ancestor) => Node.isClassDeclaration(ancestor));
    return classNode?.hasExportKeyword() ?? false;
  }

  return false;
}

export function describeCallable(node: Node, filePath: string): Callable | undefined {
  if (!isFunctionLike(node)) return undefined;

  const assigned = assignedName(node);
  const name = nameOf(node) ?? assigned ?? `anonymous@${node.getStartLineNumber()}`;
  const moduleName = path.basename(filePath, '.ts');
  const className = classNameOf(node);
  const qualifiedName = className ? `${className}.${name}` : `${moduleName}.${name}`;
  const body = bodyOf(node);
  const fullText = node.getSourceFile().getFullText();
  const signature = body
    ? fullText.slice(node.getStart(), body.getStart()).trim()
    : node.getText().split('\n')[0].trim();

  return {
    node,
    name,
    qualifiedName,
    file: filePath,
    startLine: node.getStartLineNumber(),
    endLine: node.getEndLineNumber(),
    isExported: exportFlag(node),
    signature,
    bodyText: body?.getText() ?? ''
  };
}

export function collectCallables(sourceFile: SourceFile, filePath: string): Callable[] {
  const callables: Callable[] = [];

  for (const node of sourceFile.getDescendants()) {
    let candidate = false;

    if (Node.isFunctionDeclaration(node)) candidate = true;
    else if (
      Node.isMethodDeclaration(node) ||
      Node.isGetAccessorDeclaration(node) ||
      Node.isSetAccessorDeclaration(node) ||
      Node.isConstructorDeclaration(node)
    ) {
      candidate = true;
    } else if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
      candidate = isAssignedFunction(node);
    }

    if (!candidate) continue;
    const callable = describeCallable(node, filePath);
    if (callable) callables.push(callable);
  }

  return callables;
}

export function nearestCallable(node: Node, filePath: string): Callable | undefined {
  const declaration = node.getFirstAncestor((ancestor) => isFunctionLike(ancestor));
  return declaration ? describeCallable(declaration, filePath) : undefined;
}

export function findCallableAt(
  sourceFile: SourceFile,
  filePath: string,
  startLine: number
): Callable | undefined {
  return collectCallables(sourceFile, filePath).find(
    (callable) => callable.startLine === startLine
  );
}

export type AssignableFunction = ArrowFunction | FunctionExpression | FunctionDeclaration;