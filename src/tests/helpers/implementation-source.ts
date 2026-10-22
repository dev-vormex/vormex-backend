import { readFileSync as readRawFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import ts from 'typescript';

type StatementLocation = {
  names: string[];
  file: string;
  exported: boolean;
  implementationName?: string;
  kind?: number;
  ordinal?: number;
};
type RefactorEntry = { files: string[]; statements: StatementLocation[] };
const sourceMap: Record<string, RefactorEntry> = JSON.parse(
  readRawFileSync(resolve('docs/architecture/refactor-map.json'), 'utf8')
);

function declarationNames(node: ts.Statement): string[] {
  if ('name' in node && node.name && ts.isIdentifier(node.name as ts.Node)) {
    return [(node.name as ts.Identifier).text];
  }
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations.map((entry) => entry.name.getText());
  }
  return [];
}

/** Inspect live implementations through stable import surfaces, in declaration order. */
export function readImplementationSource(file: string): string {
  const path = relative(process.cwd(), isAbsolute(file) ? file : resolve(file)).replace(/\\/g, '/');
  const entry = sourceMap[path];
  if (!entry) return readRawFileSync(file, 'utf8');
  const sources = new Map(
    entry.files.map((file) => {
      const text = readRawFileSync(file, 'utf8');
      return [file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)] as const;
    })
  );
  const declarations = new Map<string, ts.Statement>();
  for (const source of sources.values()) {
    for (const node of source.statements) {
      for (const name of declarationNames(node)) declarations.set(name, node);
    }
  }
  const imports = Array.from(sources.values()).flatMap((source) =>
    source.statements.filter(ts.isImportDeclaration).map((node) => node.getText(source))
  );
  return (
    imports.join('\n') +
    '\n\n' +
    entry.statements
      .map((location) => {
        const source = sources.get(location.file)!;
        const node = location.names.length
          ? declarations.get(location.implementationName || location.names[0])
          : source.statements.filter((node) => node.kind === location.kind)[location.ordinal || 0];
        if (!node) throw new Error(`Missing implementation: ${path} ${location.names[0]}`);
        let text = source.text.slice(node.pos, node.end).trimStart();
        if (!location.exported) text = text.replace(/^export\s+/, '');
        // Rebuild method scopes from their live operation bodies for existing safety assertions.
        if (ts.isClassDeclaration(node)) {
          const edits: { start: number; end: number; value: string }[] = [];
          for (const method of node.members) {
            if (!ts.isMethodDeclaration(method) || !method.body) continue;
            const match = method.body.getText(source).match(/return (\w+)\.call\(this/);
            const operation = match && declarations.get(match[1]);
            if (operation && ts.isFunctionDeclaration(operation) && operation.body) {
              edits.push({
                start: method.body.getStart(source) - node.getStart(source),
                end: method.body.end - node.getStart(source),
                value: operation.body.getText(operation.getSourceFile()),
              });
            }
          }
          // Offsets above use node.getStart, so remove any leading declaration comments here.
          if (edits.length) {
            text = node.getText(source);
            for (const edit of edits.sort((a, b) => b.start - a.start)) {
              text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
            }
            if (!location.exported) text = text.replace(/^export\s+/, '');
          }
        }
        return text;
      })
      .join('\n\n')
  );
}

/** Keep ordinary fixture/migration reads intact; expand only recorded source facades. */
export const readImplementationFile: typeof readRawFileSync = ((file: unknown, options: unknown) => {
  if (typeof file === 'string' && (options === 'utf8' || options === 'utf-8')) {
    const path = relative(process.cwd(), isAbsolute(file) ? file : resolve(file)).replace(/\\/g, '/');
    if (sourceMap[path]) return readImplementationSource(file);
  }
  return readRawFileSync(file as Parameters<typeof readRawFileSync>[0], options as any);
}) as typeof readRawFileSync;

/** Check bindings against their owning module independently of formatting and folder depth. */
export function assertSourceImports(text: string, moduleSuffix: string, names: string[]): void {
  const source = ts.createSourceFile('inspection.ts', text, ts.ScriptTarget.Latest, true);
  const bindings = new Set(
    source.statements.filter(ts.isImportDeclaration).flatMap((node) => {
      if (!ts.isStringLiteral(node.moduleSpecifier) || !node.moduleSpecifier.text.endsWith(moduleSuffix)) return [];
      const imports = node.importClause?.namedBindings;
      return imports && ts.isNamedImports(imports) ? imports.elements.map((entry) => entry.name.text) : [];
    })
  );
  for (const name of names) {
    if (!bindings.has(name)) throw new Error(`${name} must be imported from ${moduleSuffix}`);
  }
}
