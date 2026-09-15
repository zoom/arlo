const { Client: PgClient } = require('pg');
const mysql = require('mysql2/promise');

const tables = [
  'users',
  'user_tokens',
  'meetings',
  'speakers',
  'transcript_segments',
  'vtt_files',
  'participant_events',
  'highlights',
  'ai_sessions',
  'ai_messages',
  'ai_citations',
];

const jsonColumns = new Set([
  'users.preferences',
  'meetings.summary',
  'user_tokens.scopes',
  'highlights.tags',
  'ai_messages.filters',
]);

function quotePostgresIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteMysqlIdentifier(identifier) {
  return `\`${identifier.replaceAll('`', '``')}\``;
}

function normalizeValue(table, column, value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  if (jsonColumns.has(`${table}.${column}`) || typeof value === 'object') {
    return JSON.stringify(value);
  }
  return value;
}

async function getPostgresColumns(client, table) {
  const result = await client.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [table],
  );
  return result.rows.map(row => row.column_name);
}

async function migrateTable(source, target, table) {
  const columns = await getPostgresColumns(source, table);
  if (columns.length === 0) throw new Error(`Source table not found: ${table}`);

  const selectList = columns.map(quotePostgresIdentifier).join(', ');
  const sourceRows = await source.query(`SELECT ${selectList} FROM ${quotePostgresIdentifier(table)}`);
  const targetColumns = columns.map(quoteMysqlIdentifier).join(', ');
  const placeholders = columns.map(() => '?').join(', ');
  const insertSql = `INSERT INTO ${quoteMysqlIdentifier(table)} (${targetColumns}) VALUES (${placeholders})`;

  for (const row of sourceRows.rows) {
    const values = columns.map(column => normalizeValue(table, column, row[column]));
    await target.execute(insertSql, values);
  }

  const [countRows] = await target.query(`SELECT COUNT(*) AS count FROM ${quoteMysqlIdentifier(table)}`);
  const targetCount = Number(countRows[0].count);
  if (targetCount !== sourceRows.rowCount) {
    throw new Error(`${table}: source=${sourceRows.rowCount}, target=${targetCount}`);
  }

  console.log(`${table}: ${targetCount} rows`);
}

async function main() {
  if (!process.env.SOURCE_DATABASE_URL || !process.env.TARGET_DATABASE_URL) {
    throw new Error('SOURCE_DATABASE_URL and TARGET_DATABASE_URL are required');
  }

  const source = new PgClient({
    connectionString: process.env.SOURCE_DATABASE_URL,
    ssl: process.env.SOURCE_DB_SSL === 'require' ? { rejectUnauthorized: false } : undefined,
  });
  const target = await mysql.createConnection(process.env.TARGET_DATABASE_URL);

  try {
    await source.connect();
    await target.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of tables) {
      await migrateTable(source, target, table);
    }
    await target.query('SET FOREIGN_KEY_CHECKS = 1');
    console.log('Migration completed successfully.');
  } finally {
    await source.end().catch(() => {});
    await target.end().catch(() => {});
  }
}

main().catch(error => {
  console.error(`Migration failed: ${error.message}`);
  process.exitCode = 1;
});
