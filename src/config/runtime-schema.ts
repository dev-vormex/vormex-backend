import { Prisma } from '@prisma/client';

type Column = { table_name: string; column_name: string };

// Derive this from the generated client so future schema changes cannot silently
// bypass the startup check. Relations do not correspond to physical columns.
export function missingRuntimeColumns(columns: Column[]): string[] {
  const available = new Set(columns.map((c) => `${c.table_name}.${c.column_name}`));
  return Prisma.dmmf.datamodel.models.flatMap((model) =>
    model.fields
      .filter((field) => field.kind !== 'object')
      .map((field) => `${model.dbName || model.name}.${field.dbName || field.name}`)
      .filter((column) => !available.has(column))
  );
}

export async function assertRuntimeSchema(client: {
  $queryRaw<T>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}, databaseUrl = process.env.DATABASE_URL): Promise<void> {
  // Prisma defaults to public even when a hardened role puts pg_catalog first
  // in search_path. current_schema() would inspect the wrong schema there.
  const schema = databaseUrl ? new URL(databaseUrl).searchParams.get('schema') || 'public' : 'public';
  const columns = await client.$queryRaw<Column[]>`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = ${schema}
  `;
  const missing = missingRuntimeColumns(columns);
  if (missing.length) {
    throw new Error(
      `Database schema is behind the generated Prisma client. Missing: ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ` (and ${missing.length - 20} more)` : ''}. ` +
      'Run npm run migrate:deploy (or node scripts/ensure-dev-schema.js for an existing development database), then restart.'
    );
  }
}
