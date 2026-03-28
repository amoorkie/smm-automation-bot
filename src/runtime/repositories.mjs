import { SHEET_HEADERS, SHEET_NAMES } from '../config/defaults.mjs';
import { computeIdempotencyKey, safeJsonParse } from '../domain/index.mjs';

function toBool(value) {
  return Boolean(Number(value ?? 0));
}

function rowToToken(row) {
  if (!row) {
    return null;
  }
  return {
    ...row,
    revision: Number(row.revision ?? 0),
    used: toBool(row.used),
    superseded: toBool(row.superseded),
    payload: safeJsonParse(row.payload_json, {}),
  };
}

function rowToRuntime(row) {
  if (!row) {
    return null;
  }
  return {
    ...row,
    active_revision: Number(row.active_revision ?? 1),
    collage_message_id: row.collage_message_id || null,
    text_message_id: row.text_message_id || null,
    active_callback_set_id: row.active_callback_set_id || '',
    schedule_input_pending: toBool(row.schedule_input_pending),
    assets_message_ids: safeJsonParse(row.assets_message_ids_json, []),
    lock_flags: safeJsonParse(row.lock_flags_json, {}),
    preview_payload: safeJsonParse(row.preview_payload_json, null),
    draft_payload: safeJsonParse(row.draft_payload_json, null),
  };
}

function rowToCollection(row) {
  if (!row) {
    return null;
  }
  return {
    ...row,
    count: Number(row.count ?? 0),
    assets: safeJsonParse(row.asset_refs_json, []),
  };
}

function assetKey(asset) {
  if (!asset) {
    return '';
  }
  if (asset.messageId != null) {
    return `msg:${asset.messageId}`;
  }
  if (asset.uniqueFileId) {
    return `uniq:${asset.uniqueFileId}`;
  }
  if (asset.fileId) {
    return `file:${asset.fileId}`;
  }
  return JSON.stringify(asset);
}

function mergeCollectionRecords(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }
  const sorted = [...rows].sort((left, right) => Number(left?.id ?? 0) - Number(right?.id ?? 0));
  const latest = sorted.at(-1);
  const mergedAssets = mergeAssets(sorted, []);
  return rowToCollection({
    ...latest,
    asset_refs_json: JSON.stringify(mergedAssets),
    count: mergedAssets.length,
  });
}

function selectLatestRow(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }
  return [...rows]
    .sort((left, right) => {
      const leftId = Number(left?.id ?? 0);
      const rightId = Number(right?.id ?? 0);
      if (leftId !== rightId) {
        return leftId - rightId;
      }
      return Number(left?.__rowNumber ?? 0) - Number(right?.__rowNumber ?? 0);
    })
    .at(-1);
}

function mergeAssets(rowsOrAssets = [], extraAssets = []) {
  const merged = new Map();
  for (const entry of rowsOrAssets) {
    const assetList = Array.isArray(entry?.assets)
      ? entry.assets
      : safeJsonParse(entry?.asset_refs_json, Array.isArray(entry) ? entry : []);
    for (const asset of assetList) {
      merged.set(assetKey(asset), asset);
    }
  }
  for (const asset of extraAssets) {
    merged.set(assetKey(asset), asset);
  }
  return [...merged.values()].sort((left, right) => Number(left?.messageId ?? 0) - Number(right?.messageId ?? 0));
}

export function createRepositories(sheets) {
  const queryMany = async (tableName, options = {}) => (
    typeof sheets.getRowsByQuery === 'function'
      ? sheets.getRowsByQuery(tableName, options)
      : sheets.getRows(tableName)
  );
  const queryOne = async (tableName, options = {}) => {
    if (typeof sheets.getRowByQuery === 'function') {
      return sheets.getRowByQuery(tableName, options);
    }
    const rows = await queryMany(tableName, options);
    return rows[0] ?? null;
  };

  return {
    async upsertSession(record) {
      await sheets.upsertRowByColumn(
        SHEET_NAMES.tgSessions,
        'session_id',
        record.session_id,
        record,
        SHEET_HEADERS[SHEET_NAMES.tgSessions],
      );
    },
    async getSessionById(sessionId) {
      return queryOne(SHEET_NAMES.tgSessions, {
        eq: { session_id: sessionId },
      });
    },
    async getSessionByChatAndMode(chatId, mode) {
      return queryOne(SHEET_NAMES.tgSessions, {
        eq: { chat_id: String(chatId), mode },
      });
    },
    async deleteSession(sessionId) {
      const row = await this.getSessionById(sessionId);
      if (row) {
        await sheets.deleteRowByNumber(SHEET_NAMES.tgSessions, row.__rowNumber);
      }
    },
    async cleanupSessions(nowIso) {
      const rows = await queryMany(SHEET_NAMES.tgSessions);
      const expired = rows.filter((row) => row.expires_at && row.expires_at <= nowIso);
      await sheets.deleteRowsByNumbers(SHEET_NAMES.tgSessions, expired.map((row) => row.__rowNumber));
      return expired.length;
    },

    async createCollection(record) {
      await sheets.upsertRowByColumn(
        SHEET_NAMES.workCollections,
        'collection_id',
        record.collection_id,
        record,
        SHEET_HEADERS[SHEET_NAMES.workCollections],
      );
    },
    async updateCollection(record) {
      const existing = await queryOne(SHEET_NAMES.workCollections, {
        eq: { collection_id: record.collection_id },
        orderBy: [{ column: 'id', ascending: false }],
      });
      if (!existing) {
        throw new Error(`Collection not found: ${record.collection_id}`);
      }
      await sheets.updateRowByNumber(
        SHEET_NAMES.workCollections,
        existing.__rowNumber,
        { ...existing, ...record },
        SHEET_HEADERS[SHEET_NAMES.workCollections],
      );
    },
    async getCollectionById(collectionId) {
      const rows = await queryMany(SHEET_NAMES.workCollections, {
        eq: { collection_id: collectionId },
      });
      return mergeCollectionRecords(rows);
    },
    async mergeAlbumCollection({
      collectionId,
      collectionKey,
      chatId,
      userId,
      messageId,
      mediaGroupId,
      asset,
      currentTime,
      debounceDeadlineAt,
      buildDeadlineAt,
    }) {
      const matching = await queryMany(SHEET_NAMES.workCollections, {
        eq: { collection_id: collectionId },
        orderBy: [{ column: 'id', ascending: true }],
      });
      const newest = selectLatestRow(matching);
      const mergedAssets = mergeAssets(matching, [asset]);
      const deadlineAt = typeof buildDeadlineAt === 'function'
        ? buildDeadlineAt(mergedAssets.length)
        : debounceDeadlineAt;

      const canonical = {
        collection_id: collectionId,
        collection_key: collectionKey,
        chat_id: chatId,
        user_id: userId,
        first_message_id: newest?.first_message_id ?? messageId,
        media_group_id: mediaGroupId ?? '',
        status: newest?.status ?? 'collecting',
        asset_refs_json: JSON.stringify(mergedAssets),
        count: mergedAssets.length,
        deadline_at: deadlineAt,
        last_message_at: currentTime,
        closed_by_job_id: newest?.closed_by_job_id ?? '',
        created_at: newest?.created_at ?? currentTime,
        updated_at: currentTime,
      };

      if (newest) {
        await sheets.updateRowByNumber(
          SHEET_NAMES.workCollections,
          newest.__rowNumber,
          { ...newest, ...canonical },
          SHEET_HEADERS[SHEET_NAMES.workCollections],
        );
      } else {
        await sheets.appendRow(
          SHEET_NAMES.workCollections,
          canonical,
          SHEET_HEADERS[SHEET_NAMES.workCollections],
        );
      }

      const rowsForDedup = newest
        ? matching
        : await queryMany(SHEET_NAMES.workCollections, {
          eq: { collection_id: collectionId },
          orderBy: [{ column: 'id', ascending: true }],
        });
      if (rowsForDedup.length > 1) {
        const latest = selectLatestRow(rowsForDedup);
        const dedupedAssets = mergeAssets(rowsForDedup, []);
        await sheets.updateRowByNumber(
          SHEET_NAMES.workCollections,
          latest.__rowNumber,
          {
            ...latest,
            ...canonical,
            asset_refs_json: JSON.stringify(dedupedAssets),
            count: dedupedAssets.length,
          },
          SHEET_HEADERS[SHEET_NAMES.workCollections],
        );
        const duplicateRows = rowsForDedup
          .filter((row) => row.__rowNumber !== latest.__rowNumber)
          .map((row) => row.__rowNumber);
        await sheets.deleteRowsByNumbers(SHEET_NAMES.workCollections, duplicateRows);
        return rowToCollection({
          ...latest,
          ...canonical,
          asset_refs_json: JSON.stringify(dedupedAssets),
          count: dedupedAssets.length,
        });
      }

      return rowToCollection({
        ...(newest ?? {}),
        ...canonical,
      });
    },
    async getOpenCollectionForChat(chatId) {
      const row = await queryOne(SHEET_NAMES.workCollections, {
        eq: { chat_id: String(chatId), status: 'collecting' },
        orderBy: [{ column: 'updated_at', ascending: false }],
      });
      return rowToCollection(row);
    },
    async listDueCollections(nowIso) {
      const rows = await queryMany(SHEET_NAMES.workCollections, {
        eq: { status: 'collecting' },
        orderBy: [{ column: 'deadline_at', ascending: true }],
      });
      const grouped = rows.reduce((accumulator, row) => {
        if (!accumulator.has(row.collection_id)) {
          accumulator.set(row.collection_id, []);
        }
        accumulator.get(row.collection_id).push(row);
        return accumulator;
      }, new Map());
      return [...grouped.values()]
        .map((groupRows) => mergeCollectionRecords(groupRows))
        .filter((row) => row && row.status === 'collecting' && row.deadline_at <= nowIso)
        .sort((left, right) => String(left.deadline_at).localeCompare(String(right.deadline_at)));
    },
    async closeCollection(record) {
      const existing = await queryOne(SHEET_NAMES.workCollections, {
        eq: { collection_id: record.collection_id },
        orderBy: [{ column: 'id', ascending: false }],
      });
      if (!existing) {
        return;
      }
      await sheets.updateRowByNumber(
        SHEET_NAMES.workCollections,
        existing.__rowNumber,
        { ...existing, ...record },
        SHEET_HEADERS[SHEET_NAMES.workCollections],
      );
    },

    async createCallbackTokens(tokenRows) {
      if (typeof sheets.upsertRowsByColumn === 'function') {
        await sheets.upsertRowsByColumn(
          SHEET_NAMES.callbackTokens,
          'token',
          tokenRows,
          SHEET_HEADERS[SHEET_NAMES.callbackTokens],
        );
        return;
      }
      for (const row of tokenRows) {
        await sheets.upsertRowByColumn(
          SHEET_NAMES.callbackTokens,
          'token',
          row.token,
          row,
          SHEET_HEADERS[SHEET_NAMES.callbackTokens],
        );
      }
    },
    async getCallbackToken(token) {
      return rowToToken(await queryOne(SHEET_NAMES.callbackTokens, {
        eq: { token },
      }));
    },
    async listCallbackTokensByTokenSet(tokenSetId) {
      const rows = await queryMany(SHEET_NAMES.callbackTokens, {
        eq: { token_set_id: tokenSetId },
      });
      return rows
        .map(rowToToken);
    },
    async markCallbackUsed(token, updatedAt) {
      const row = await queryOne(SHEET_NAMES.callbackTokens, {
        eq: { token },
      });
      if (!row) {
        return;
      }
      await sheets.updateRowByNumber(
        SHEET_NAMES.callbackTokens,
        row.__rowNumber,
        { ...row, used: 1, updated_at: updatedAt },
        SHEET_HEADERS[SHEET_NAMES.callbackTokens],
      );
    },
    async supersedeTokenSet(tokenSetId, updatedAt) {
      if (!tokenSetId) {
        return;
      }
      if (typeof sheets.updateRowsByQuery === 'function') {
        await sheets.updateRowsByQuery(
          SHEET_NAMES.callbackTokens,
          { superseded: 1, updated_at: updatedAt },
          { eq: { token_set_id: tokenSetId } },
        );
        return;
      }
      const rows = await queryMany(SHEET_NAMES.callbackTokens, {
        eq: { token_set_id: tokenSetId },
      });
      for (const row of rows) {
        await sheets.updateRowByNumber(
          SHEET_NAMES.callbackTokens,
          row.__rowNumber,
          { ...row, superseded: 1, updated_at: updatedAt },
          SHEET_HEADERS[SHEET_NAMES.callbackTokens],
        );
      }
    },
    async cleanupCallbackTokens(nowIso) {
      const rows = await queryMany(SHEET_NAMES.callbackTokens);
      const expired = rows.filter((row) => row.expires_at <= nowIso);
      await sheets.deleteRowsByNumbers(SHEET_NAMES.callbackTokens, expired.map((row) => row.__rowNumber));
      return expired.length;
    },

    async recordIdempotency(scope, payload, nowIso, expiresAt) {
      const idemKey = computeIdempotencyKey(scope, payload);
      try {
        await sheets.appendRow(
          SHEET_NAMES.idempotencyKeys,
          {
            idem_key: idemKey,
            scope,
            payload_hash: JSON.stringify(payload),
            created_at: nowIso,
            expires_at: expiresAt,
          },
          SHEET_HEADERS[SHEET_NAMES.idempotencyKeys],
        );
        return { idemKey, inserted: true };
      } catch (error) {
        if (/duplicate key|already exists|23505|unique constraint|violates unique/i.test(String(error?.message ?? ''))) {
          return { idemKey, inserted: false };
        }
        throw error;
      }
    },
    async hasIdempotency(idemKey) {
      return Boolean(await queryOne(SHEET_NAMES.idempotencyKeys, {
        eq: { idem_key: idemKey },
      }));
    },
    async cleanupIdempotency(nowIso) {
      const rows = await sheets.getRows(SHEET_NAMES.idempotencyKeys);
      const expired = rows.filter((row) => row.expires_at && row.expires_at <= nowIso);
      await sheets.deleteRowsByNumbers(SHEET_NAMES.idempotencyKeys, expired.map((row) => row.__rowNumber));
      return expired.length;
    },

    async acquirePublishLock({ lockKey, jobId, queueId, createdAt, expiresAt }) {
      const existing = await queryOne(SHEET_NAMES.publishLocks, {
        eq: { lock_key: lockKey },
      });
      if (existing && (!existing.expires_at || existing.expires_at > createdAt)) {
        return false;
      }
      if (existing) {
        await sheets.deleteRowByNumber(SHEET_NAMES.publishLocks, existing.__rowNumber);
      }
      await sheets.appendRow(
        SHEET_NAMES.publishLocks,
        {
          lock_key: lockKey,
          job_id: jobId,
          queue_id: queueId,
          created_at: createdAt,
          expires_at: expiresAt,
        },
        SHEET_HEADERS[SHEET_NAMES.publishLocks],
      );
      return true;
    },
    async releasePublishLock(lockKey) {
      const row = await queryOne(SHEET_NAMES.publishLocks, {
        eq: { lock_key: lockKey },
      });
      if (row) {
        await sheets.deleteRowByNumber(SHEET_NAMES.publishLocks, row.__rowNumber);
      }
    },
    async cleanupPublishLocks(nowIso) {
      const rows = await queryMany(SHEET_NAMES.publishLocks);
      const expired = rows.filter((row) => row.expires_at && row.expires_at <= nowIso);
      await sheets.deleteRowsByNumbers(SHEET_NAMES.publishLocks, expired.map((row) => row.__rowNumber));
      return expired.length;
    },

    async upsertRuntime(record) {
      await sheets.upsertRowByColumn(
        SHEET_NAMES.jobRuntimeCache,
        'job_id',
        record.job_id,
        record,
        SHEET_HEADERS[SHEET_NAMES.jobRuntimeCache],
      );
    },
    async getRuntime(jobId) {
      return rowToRuntime(await queryOne(SHEET_NAMES.jobRuntimeCache, {
        eq: { job_id: jobId },
      }));
    },
    async listRuntimesByStatus(status) {
      const rows = await queryMany(SHEET_NAMES.jobRuntimeCache, {
        eq: { runtime_status: String(status) },
      });
      return rows
        .map(rowToRuntime);
    },
    async getQueueRowByJobId(jobId) {
      return queryOne(SHEET_NAMES.contentQueue, {
        eq: { job_id: jobId },
        orderBy: [{ column: 'id', ascending: false }],
      });
    },
    async getQueueRowByQueueId(queueId) {
      return queryOne(SHEET_NAMES.contentQueue, {
        eq: { queue_id: queueId },
      });
    },
  };
}

export default createRepositories;
