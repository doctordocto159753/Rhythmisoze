/**
 * US-1302 - reproducible migrations.
 *
 * Applies every `migrations/*.sql` file in filename order, inside one
 * transaction each, and records what it applied so a re-run is a no-op.
 * Deliberately tiny: a migration tool is not the interesting part of this
 * product, and a dependency here would be one more thing to keep current.
 *
 *     DATABASE_URL=postgres://... npm run db:migrate
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const url = process.env.DATABASE_URL;

if (!url) {
  console.error('DATABASE_URL is not set. Nothing to migrate.');
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false });

await sql`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name       TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;

const applied = new Set((await sql`SELECT name FROM schema_migrations`).map((r) => r.name));
const files = readdirSync(join(root, 'migrations')).filter((f) => f.endsWith('.sql')).sort();

let count = 0;
for (const file of files) {
  if (applied.has(file)) {
    console.log(`skip  ${file}`);
    continue;
  }
  const statements = readFileSync(join(root, 'migrations', file), 'utf8');
  await sql.begin(async (tx) => {
    await tx.unsafe(statements);
    await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
  });
  console.log(`apply ${file}`);
  count += 1;
}

console.log(count === 0 ? 'database already up to date' : `applied ${count} migration(s)`);
await sql.end();
