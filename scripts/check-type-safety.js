#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..');
const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
if (config.error) {
  console.error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  process.exit(1);
}
const { options, errors } = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const failures = errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'));
const strictOptions = [
  'noImplicitAny',
  'strictNullChecks',
  'strictFunctionTypes',
  'strictBindCallApply',
  'strictPropertyInitialization',
  'noImplicitThis',
  'alwaysStrict',
  'useUnknownInCatchVariables',
];
if (!options.strict || strictOptions.some((option) => options[option] === false)) {
  failures.push('TypeScript strict checking and all its constituent checks must remain enabled.');
}

const baseline = JSON.parse(fs.readFileSync(path.join(root, 'docs/architecture/type-safety-debt.json'), 'utf8'));
const remaining = new Map(baseline.map((entry) => [entry.file, entry.nocheck]));
if (remaining.size !== baseline.length) failures.push('Duplicate type-safety debt entries.');

function inspect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      inspect(file);
      continue;
    }
    if (!/\.(ts|js)$/.test(entry.name)) continue;
    const relative = path.relative(root, file).split(path.sep).join('/');
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false);
    scanner.setText(fs.readFileSync(file, 'utf8'));
    let count = 0;
    for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
      if (token !== ts.SyntaxKind.SingleLineCommentTrivia && token !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
      const comment = scanner.getTokenText();
      const directive = /^[\s/*]*@ts-(nocheck|ignore|expect-error)\b([^\r\n]*)/.exec(comment);
      if (directive?.[1] === 'nocheck') count++;
      if (directive?.[1] === 'ignore') {
        failures.push(`${relative}: use a checked type or a documented @ts-expect-error, never @ts-ignore.`);
      }
      if (directive?.[1] === 'expect-error' && directive[2].replace(/\*\/$/, '').trim().length < 10) {
        failures.push(`${relative}: @ts-expect-error must explain the unresolved compiler error.`);
      }
    }
    const allowed = remaining.get(relative) || 0;
    if (count > allowed) failures.push(`${relative}: new @ts-nocheck suppression (${count} > ${allowed}).`);
    if (allowed && count < allowed) failures.push(`${relative}: remove the resolved entry from type-safety-debt.json.`);
    remaining.delete(relative);
  }
}

inspect(path.join(root, 'src'));
inspect(path.join(root, 'scripts'));
for (const file of remaining.keys()) failures.push(`${file}: stale type-safety debt entry.`);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`Type-safety checks passed (strict checking; ${baseline.length} recorded legacy files).`);
