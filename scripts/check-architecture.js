#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.join(__dirname, '..');
const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, root);

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(fullPath) : /\.(ts|js)$/.test(entry.name) ? [fullPath] : [];
  });
}

function repositoryPath(file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function forbiddenDependency(from, to) {
  const isFeature = from.startsWith('src/modules/');
  const isInfrastructure = from.startsWith('src/infrastructure/');
  const isShared = from.startsWith('src/shared/');
  const isApplicationComposition = /^(src\/bootstrap\/|src\/http\/|src\/jobs\/)/.test(to);
  if ((isFeature || isInfrastructure || isShared) && isApplicationComposition) {
    return 'lower layers cannot import process, HTTP, or job composition';
  }
  if (
    (isFeature || isInfrastructure || isShared) &&
    to.startsWith('src/realtime/') &&
    to !== 'src/realtime/socket-registry.ts'
  ) {
    return 'lower layers may use the socket registry, not socket setup or handlers';
  }
  if ((isInfrastructure || /\/services\//.test(from)) && /\/modules\/[^/]+\/(controllers|routes)\//.test(to)) {
    return 'services and infrastructure cannot depend on HTTP controllers or routes';
  }
  if (from.startsWith('src/http/') && /^(src\/bootstrap\/|src\/jobs\/)/.test(to)) {
    return 'HTTP composition cannot start processes or depend on job implementations';
  }
  if (
    [
      'src/api.ts',
      'src/index.ts',
      'src/worker.ts',
      'src/scheduler.ts',
      'src/proximity-worker.ts',
      'src/proximity-scheduler.ts',
    ].includes(to)
  ) {
    return 'process entry points must not be imported as application dependencies';
  }
  return null;
}

const failures = [];
let dependencyCount = 0;
const allSourceFiles = sourceFiles(path.join(root, 'src'));
const files = allSourceFiles.filter((file) => !repositoryPath(file).startsWith('src/tests/'));
const MAX_IMPLEMENTATION_LINES = 600;
for (const file of [...allSourceFiles, ...sourceFiles(path.join(root, 'scripts'))]) {
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split(/\r?\n/).length;
  if (lines > MAX_IMPLEMENTATION_LINES)
    failures.push(
      `${repositoryPath(file)}: ${lines} lines exceeds the ${MAX_IMPLEMENTATION_LINES}-line limit; split by responsibility`
    );
}
for (const file of files) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  function visit(node) {
    let specifier;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      specifier = node.moduleSpecifier;
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require')
    ) {
      specifier = node.arguments[0];
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      specifier = node.argument.literal;
    }
    if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('.')) {
      const resolved = ts.resolveModuleName(specifier.text, file, options, ts.sys).resolvedModule;
      const from = repositoryPath(file);
      if (!resolved) {
        failures.push(`${from}: unresolved import ${specifier.text}`);
      } else {
        const to = repositoryPath(resolved.resolvedFileName);
        dependencyCount++;
        // api.ts intentionally keeps the historical index.ts entry available.
        const reason = from === 'src/api.ts' && to === 'src/index.ts' ? null : forbiddenDependency(from, to);
        if (reason) failures.push(`${from} -> ${to}: ${reason}`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}

// Refactored modules must have no runtime dependency cycles. Type-only imports are erased.
const refactorMap = JSON.parse(fs.readFileSync(path.join(root, 'docs/architecture/refactor-map.json'), 'utf8'));
const refactoredFiles = new Set(Object.values(refactorMap).flatMap((entry) => entry.files));
const graph = new Map();
for (const file of refactoredFiles) {
  const absolute = path.join(root, file);
  const output = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const dependencies = [...output.matchAll(/require\(["'](\.[^"']*)["']\)/g)]
    .map((match) => {
      const resolved = ts.resolveModuleName(match[1], absolute, options, ts.sys).resolvedModule;
      return resolved && repositoryPath(resolved.resolvedFileName);
    })
    .filter((dependency) => refactoredFiles.has(dependency));
  graph.set(file, dependencies);
}
const visited = new Set();
const active = new Set();
function visitDependencies(file, stack) {
  if (active.has(file)) {
    failures.push(`Runtime dependency cycle: ${[...stack.slice(stack.indexOf(file)), file].join(' -> ')}`);
    return;
  }
  if (visited.has(file)) return;
  active.add(file);
  for (const dependency of graph.get(file) || []) visitDependencies(dependency, [...stack, file]);
  active.delete(file);
  visited.add(file);
}
for (const file of graph.keys()) visitDependencies(file, []);

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Architecture checks passed (${files.length} source files, ${dependencyCount} local dependencies).`);
}
