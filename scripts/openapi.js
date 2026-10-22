#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');
const SwaggerParser = require('@apidevtools/swagger-parser');

async function main() {
  const command = process.argv[2];
  const source = path.join(__dirname, '..', 'src', 'openapi.yaml');
  if (command === 'validate') {
    await SwaggerParser.validate(source);
    console.log('src/openapi.yaml is valid');
  } else if (command === 'bundle') {
    const document = await SwaggerParser.bundle(source);
    await fs.writeFile(path.join(__dirname, '..', 'src', 'openapi.json'), JSON.stringify(document, null, 2) + '\n');
    console.log('Bundled src/openapi.yaml -> src/openapi.json');
  } else {
    throw new Error('Usage: node scripts/openapi.js <validate|bundle>');
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
