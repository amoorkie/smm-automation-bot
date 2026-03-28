import test from 'node:test';
import assert from 'node:assert/strict';

import createRepositories from '../src/runtime/repositories.mjs';
import { TABLE_NAMES } from '../src/config/defaults.mjs';

class FakeSheets {
  constructor(initialRows = []) {
    this.rows = initialRows.map((row, index) => ({
      ...row,
      id: row.id ?? index + 1,
      __rowNumber: row.__rowNumber ?? index + 1,
    }));
    this.getRowsCalls = 0;
    this.getRowsByQueryCalls = 0;
  }

  async getRows() {
    this.getRowsCalls += 1;
    return this.rows.map((row) => ({ ...row }));
  }

  async getRowsByQuery(_tableName, options = {}) {
    this.getRowsByQueryCalls += 1;
    let output = this.rows.map((row) => ({ ...row }));
    for (const [column, value] of Object.entries(options.eq ?? {})) {
      output = output.filter((row) => String(row[column] ?? '') === String(value));
    }
    for (const rule of options.orderBy ?? []) {
      output.sort((left, right) => {
        const leftValue = String(left[rule.column] ?? '');
        const rightValue = String(right[rule.column] ?? '');
        return rule.ascending === false
          ? rightValue.localeCompare(leftValue, 'ru', { numeric: true })
          : leftValue.localeCompare(rightValue, 'ru', { numeric: true });
      });
    }
    return output;
  }

  async getRowByQuery(tableName, options = {}) {
    const rows = await this.getRowsByQuery(tableName, options);
    return rows[0] ?? null;
  }

  async updateRowByNumber(_tableName, rowNumber, record) {
    const index = this.rows.findIndex((row) => row.__rowNumber === rowNumber);
    if (index >= 0) {
      this.rows[index] = { ...this.rows[index], ...record };
    }
  }

  async appendRow(_tableName, record) {
    const id = this.rows.length + 1;
    this.rows.push({ ...record, id, __rowNumber: id });
  }

  async deleteRowsByNumbers(_tableName, rowNumbers) {
    const set = new Set(rowNumbers);
    this.rows = this.rows.filter((row) => !set.has(row.__rowNumber));
  }
}

test('closeCollection uses targeted query path and avoids full-table scan', async () => {
  const sheets = new FakeSheets([
    { collection_id: 'c-1', status: 'collecting' },
  ]);
  const repos = createRepositories(sheets);

  await repos.closeCollection({
    collection_id: 'c-1',
    status: 'awaiting_render_mode',
  });

  assert.equal(sheets.getRowsCalls, 0);
  assert.ok(sheets.getRowsByQueryCalls >= 1);
  assert.equal(sheets.rows[0].status, 'awaiting_render_mode');
});

test('listDueCollections filters by collecting status via query options', async () => {
  const sheets = new FakeSheets([
    {
      collection_id: 'c-due',
      status: 'collecting',
      deadline_at: '2026-01-01T00:00:00.000Z',
      asset_refs_json: '[]',
      count: 0,
    },
    {
      collection_id: 'c-skip',
      status: 'closed',
      deadline_at: '2026-01-01T00:00:00.000Z',
      asset_refs_json: '[]',
      count: 0,
    },
  ]);
  const repos = createRepositories(sheets);

  const due = await repos.listDueCollections('2026-01-02T00:00:00.000Z');

  assert.equal(sheets.getRowsCalls, 0);
  assert.equal(due.length, 1);
  assert.equal(due[0].collection_id, 'c-due');
});

