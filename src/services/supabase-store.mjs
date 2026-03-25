import { createClient } from '@supabase/supabase-js';

function normalizeRow(row) {
  if (!row) {
    return null;
  }
  return {
    __rowNumber: row.id,
    ...row,
  };
}

function normalizeColumns(columns = '*') {
  if (columns === '*' || !columns) {
    return '*';
  }
  const list = Array.isArray(columns) ? columns : String(columns).split(',').map((item) => item.trim()).filter(Boolean);
  return list.includes('id') ? list.join(',') : ['id', ...list].join(',');
}

function normalizeOrderBy(orderBy) {
  return Array.isArray(orderBy) ? orderBy : [];
}

function selectPayload(row, columns = []) {
  if (!columns || columns.length === 0) {
    const { __rowNumber, id, ...rest } = row ?? {};
    return rest;
  }
  const payload = {};
  for (const column of columns) {
    if (column in (row ?? {})) {
      payload[column] = row[column];
    }
  }
  return payload;
}

function assertNoError(error, context) {
  if (error) {
    throw new Error(`${context}: ${error.message}`);
  }
}

export function createSupabaseAdminClient({ supabaseUrl, supabaseServiceRoleKey }) {
  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

export class SupabaseStoreService {
  constructor({ client, url, serviceRoleKey, supabaseUrl, supabaseServiceRoleKey }) {
    this.client = client ?? createSupabaseAdminClient({
      supabaseUrl: supabaseUrl ?? url,
      supabaseServiceRoleKey: supabaseServiceRoleKey ?? serviceRoleKey,
    });
  }

  async validateContract(tableColumnsMap = {}) {
    for (const tableName of Object.keys(tableColumnsMap)) {
      const { error } = await this.client
        .from(tableName)
        .select('id', { head: true, count: 'exact' })
        .limit(1);
      assertNoError(error, `Supabase contract validation failed for ${tableName}`);
    }
  }

  async getRows(tableName) {
    const { data, error } = await this.client
      .from(tableName)
      .select('*')
      .order('id', { ascending: true });
    assertNoError(error, `Failed to fetch rows from ${tableName}`);
    return (data ?? []).map(normalizeRow);
  }

  async getRowsByQuery(
    tableName,
    {
      columns = '*',
      eq = {},
      inFilters = {},
      orderBy = [{ column: 'id', ascending: true }],
      offset = null,
      limit = null,
    } = {},
  ) {
    let query = this.client
      .from(tableName)
      .select(normalizeColumns(columns));

    for (const [column, value] of Object.entries(eq ?? {})) {
      query = query.eq(column, value);
    }

    for (const [column, values] of Object.entries(inFilters ?? {})) {
      const normalizedValues = Array.isArray(values) ? values.filter((value) => value !== undefined && value !== null) : [];
      if (normalizedValues.length > 0) {
        query = query.in(column, normalizedValues);
      }
    }

    for (const rule of normalizeOrderBy(orderBy)) {
      if (rule?.column) {
        query = query.order(rule.column, { ascending: rule.ascending !== false });
      }
    }

    if (Number.isInteger(offset) && Number.isInteger(limit) && limit > 0) {
      query = query.range(offset, offset + limit - 1);
    } else if (Number.isInteger(limit) && limit > 0) {
      query = query.limit(limit);
    }

    const { data, error } = await query;
    assertNoError(error, `Failed to query rows from ${tableName}`);
    return (data ?? []).map(normalizeRow);
  }

  async getRowByQuery(tableName, queryOptions = {}) {
    const rows = await this.getRowsByQuery(tableName, {
      ...queryOptions,
      limit: 1,
    });
    return rows[0] ?? null;
  }

  async countRowsByQuery(tableName, { eq = {}, inFilters = {} } = {}) {
    let query = this.client
      .from(tableName)
      .select('id', { head: true, count: 'exact' });

    for (const [column, value] of Object.entries(eq ?? {})) {
      query = query.eq(column, value);
    }

    for (const [column, values] of Object.entries(inFilters ?? {})) {
      const normalizedValues = Array.isArray(values) ? values.filter((value) => value !== undefined && value !== null) : [];
      if (normalizedValues.length > 0) {
        query = query.in(column, normalizedValues);
      }
    }

    const { count, error } = await query;
    assertNoError(error, `Failed to count rows in ${tableName}`);
    return Number(count ?? 0);
  }

  async appendRow(tableName, row, columns) {
    const payload = selectPayload(row, columns);
    const { data, error } = await this.client
      .from(tableName)
      .insert(payload)
      .select('*')
      .single();
    assertNoError(error, `Failed to append row to ${tableName}`);
    return normalizeRow(data);
  }

  async updateRowByNumber(tableName, rowNumber, row, columns) {
    const payload = selectPayload(row, columns);
    const { error } = await this.client
      .from(tableName)
      .update(payload)
      .eq('id', rowNumber);
    assertNoError(error, `Failed to update row ${rowNumber} in ${tableName}`);
  }

  async upsertRowByColumn(tableName, keyColumn, keyValue, patch, columns) {
    const payload = selectPayload(patch, columns);
    const { data: existing, error: selectError } = await this.client
      .from(tableName)
      .select('id')
      .eq(keyColumn, keyValue)
      .maybeSingle();
    assertNoError(selectError, `Failed to lookup ${tableName}.${keyColumn}`);

    if (existing?.id) {
      const { data, error } = await this.client
        .from(tableName)
        .update(payload)
        .eq('id', existing.id)
        .select('id')
        .single();
      assertNoError(error, `Failed to upsert row in ${tableName}`);
      return { mode: 'update', rowNumber: data.id };
    }

    const { data, error } = await this.client
      .from(tableName)
      .insert(payload)
      .select('id')
      .single();
    assertNoError(error, `Failed to insert row in ${tableName}`);
    return { mode: 'insert', rowNumber: data.id };
  }

  async upsertRowsByColumn(tableName, keyColumn, rows, columns) {
    const normalizedRows = Array.isArray(rows) ? rows.filter(Boolean) : [];
    if (normalizedRows.length === 0) {
      return [];
    }
    const payload = normalizedRows.map((row) => selectPayload(row, columns));
    const { error } = await this.client
      .from(tableName)
      .upsert(payload, { onConflict: keyColumn });
    assertNoError(error, `Failed to bulk upsert rows in ${tableName}`);
    return normalizedRows.map((row) => ({ keyValue: row[keyColumn] }));
  }

  async updateRowsByQuery(tableName, patch, { eq = {}, inFilters = {} } = {}) {
    let query = this.client
      .from(tableName)
      .update(patch);

    for (const [column, value] of Object.entries(eq ?? {})) {
      query = query.eq(column, value);
    }

    for (const [column, values] of Object.entries(inFilters ?? {})) {
      const normalizedValues = Array.isArray(values) ? values.filter((value) => value !== undefined && value !== null) : [];
      if (normalizedValues.length > 0) {
        query = query.in(column, normalizedValues);
      }
    }

    const { error } = await query;
    assertNoError(error, `Failed to update rows in ${tableName}`);
  }

  async deleteRowByNumber(tableName, rowNumber) {
    const { error } = await this.client
      .from(tableName)
      .delete()
      .eq('id', rowNumber);
    assertNoError(error, `Failed to delete row ${rowNumber} from ${tableName}`);
  }

  async deleteRowsByNumbers(tableName, rowNumbers) {
    const ids = [...new Set(rowNumbers)].filter(Boolean);
    if (ids.length === 0) {
      return;
    }
    const { error } = await this.client
      .from(tableName)
      .delete()
      .in('id', ids);
    assertNoError(error, `Failed to delete rows from ${tableName}`);
  }
}

export default SupabaseStoreService;
