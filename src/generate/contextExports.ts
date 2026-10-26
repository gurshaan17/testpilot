/**
 * Exported-symbol summaries so generated tests import real names only.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Node, Project, type SourceFile } from 'ts-morph';
import { isForbiddenText, normalize } from './contextFiles';

export interface ExportedSymbol {
  module: string;
  importPath: string;
  name: string;
  kind: string;
  signature: string;
  isHelper: boolean;
}

export function sourceAt(
  project: Project,
  worktreeDir: string,
  filePath: string
): SourceFile | undefined {
  const absolute = path.join(worktreeDir, filePath);
  const existing = project.getSourceFile(absolute);
  if (existing) return existing;
  return existsSync(absolute) ? project.addSourceFileAtPath(absolute) : undefined;
}

export function exportedSymbols(
  project: Project,
  worktreeDir: string,
  module: string
): ExportedSymbol[] {
  const sourceFile = sourceAt(project, worktreeDir, module);
  if (!sourceFile) return [];

  const symbols: ExportedSymbol[] = [];
  const relativeModule = module.replace(/\.ts$/, '');
  const importPath = normalize(path.posix.relative('__testpilot__', relativeModule));

  for (const [name, declarations] of sourceFile.getExportedDeclarations()) {
    const declaration = declarations[0];
    if (!declaration || isForbiddenText(name)) continue;

    let kind = declaration.getKindName();
    let signature = name;

    if (Node.isFunctionDeclaration(declaration)) {
      const body = declaration.getBody();
      signature = body
        ? declaration
            .getSourceFile()
            .getFullText()
            .slice(declaration.getStart(), body.getStart())
            .trim()
        : declaration.getText().split('\n')[0];
    } else if (Node.isClassDeclaration(declaration)) {
      kind = 'class';
      signature = `export class ${name}`;
    } else if (Node.isVariableDeclaration(declaration)) {
      kind = 'const';
      const type = declaration.getTypeNode()?.getText();
      signature = type ? `const ${name}: ${type}` : `const ${name}`;
    } else if (
      Node.isInterfaceDeclaration(declaration) ||
      Node.isTypeAliasDeclaration(declaration)
    ) {
      signature = declaration.getText().slice(0, 400);
    }

    if (isForbiddenText(signature)) signature = name;

    symbols.push({
      module,
      importPath: importPath.startsWith('.') ? importPath : `./${importPath}`,
      name,
      kind,
      signature,
      isHelper: /^__|^(reset|seed)$/.test(name)
    });
  }

  return symbols;
}