/* eslint-disable @typescript-eslint/naming-convention */
import { rowOrderIndexName } from '@teable/v2-adapter-table-repository-postgres';
import { createV2HttpClient, type V2HttpClient } from '@teable/v2-contract-http-client';
import { sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';

import { getSharedTestContext, type SharedTestContext } from './shared/globalTestContext';

/**
 * T7541: duplicating a grid view must create `__row_<viewId>` through the
 * online helper, not inside the duplicate request transaction.
 *
 * Pre-fix, `visitTableAddView` emits ALTER + full-table UPDATE +
 * non-concurrent CREATE INDEX named `idx___row_<viewId>` and runs them on
 * the caller's transaction (AccessExclusiveLock held through the backfill).
 * Post-fix the product path calls `ensureRowOrderColumnOnline` before that
 * transaction, so the only index is `rowOrderIndexName` and the legacy
 * `idx___row_<viewId>` index is absent.
 *
 * Postgres only: PGlite cannot run CREATE INDEX CONCURRENTLY.
 */
describe('v2 duplicate view row-order column (e2e, T7541)', () => {
  let ctx: SharedTestContext;
  let client: V2HttpClient;

  beforeAll(async () => {
    ctx = await getSharedTestContext({ dbMode: 'postgres' });
    expect(ctx.testContainer.connectionString).toMatch(/^postgres(?:ql)?:\/\//);
    client = createV2HttpClient({ baseUrl: ctx.baseUrl });
  }, 300000);

  it('backfills the duplicated grid view row-order column with the online index', async () => {
    const table = await ctx.createTable({
      baseId: ctx.baseId,
      name: 'T7541 Duplicate View Row Order',
      fields: [{ name: 'Name', type: 'singleLineText', isPrimary: true }],
      views: [{ type: 'grid', name: 'Source' }],
    });
    const tableId = table.id;
    const sourceViewId = table.views[0]!.id;
    const primaryFieldId = table.fields.find((field) => field.isPrimary)?.id ?? '';
    await ctx.createRecords(
      tableId,
      Array.from({ length: 6 }, (_, index) => ({
        fields: { [primaryFieldId]: `Row ${index + 1}` },
      }))
    );

    const duplicated = await client.tables.duplicateView({ tableId, viewId: sourceViewId });
    expect(duplicated.ok).toBe(true);
    if (!duplicated.ok) return;
    const duplicateViewId = duplicated.data.viewId;
    expect(duplicateViewId).not.toBe(sourceViewId);

    const tableMeta = await ctx.testContainer.db
      .selectFrom('table_meta')
      .select('db_table_name')
      .where('id', '=', tableId)
      .executeTakeFirst();
    const dbTableName = tableMeta?.db_table_name ?? '';
    expect(dbTableName).not.toBe('');
    const dotIndex = dbTableName.indexOf('.');
    const schemaName = dotIndex === -1 ? 'public' : dbTableName.slice(0, dotIndex);
    const plainTableName = dotIndex === -1 ? dbTableName : dbTableName.slice(dotIndex + 1);
    const orderColumn = `__row_${duplicateViewId}`;
    const onlineIndexName = rowOrderIndexName(dbTableName, duplicateViewId);
    const legacyIndexName = `idx_${orderColumn}`;

    const column = await sql<{ column_name: string }>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = ${schemaName}
        AND table_name = ${plainTableName}
        AND column_name = ${orderColumn}
    `.execute(ctx.testContainer.db);
    expect(column.rows).toHaveLength(1);

    const rows = await sql<{ __auto_number: number; order_value: number | null }>`
      SELECT "__auto_number", ${sql.ref(orderColumn)} AS order_value
      FROM ${sql.table(dbTableName)}
      ORDER BY "__auto_number" ASC
    `.execute(ctx.testContainer.db);
    expect(rows.rows).toHaveLength(6);
    for (const row of rows.rows) {
      expect(Number(row.order_value)).toBe(Number(row.__auto_number));
    }

    const indexes = await sql<{ relname: string; indisvalid: boolean }>`
      SELECT c.relname, i.indisvalid
      FROM pg_class c
      JOIN pg_index i ON i.indexrelid = c.oid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${schemaName}
        AND c.relname IN (${onlineIndexName}, ${legacyIndexName})
    `.execute(ctx.testContainer.db);
    expect(indexes.rows.map((row) => row.relname)).toEqual([onlineIndexName]);
    expect(indexes.rows[0]?.indisvalid).toBe(true);
  }, 120000);
});
