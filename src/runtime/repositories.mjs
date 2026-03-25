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
      const rows = await sheets.getRows(SHEET_NAMES.tgSessions);
      return rows.find((row) => row.session_id === sessionId) ?? null;
    },
    async getSessionByChatAndMode(chatId, mode) {
      const rows = await sheets.getRows(SHEET_NAMES.tgSessions);
      return rows.find((row) => String(row.chat_id) === String(chatId) && row.mode === mode) ?? null;
    },
    async deleteSession(sessionId) {
      const rows = await sheets.getRows(SHEET_NAMES.tgSessions);
      const row = rows.find((item) => item.session_id === sessionId);
      if (row) {
        await sheets.deleteRowByNumber(SHEET_NAMES.tgSessions, row.__rowNumber);
      }
    },
    async cleanupSessions(nowIso) {
      const rows = await sheets.getRows(SHEET_NAMES.tgSessions);
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
      const rows = await sheets.getRows(SHEET_NAMES.workCollections);
      const existing = rows.filter((row) => row.collection_id === record.collection_id).at(-1);
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
      const rows = await sheets.getRows(SHEET_NAMES.workCollections);
      return mergeCollectionRecords(rows.filter((row) => row.collection_id === collectionId));
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
      const allRows = await sheets.getRows(SHEET_NAMES.workCollections);
      const matching = allRows.filter((row) => row.collection_id === collectionId);
      const newest = matching.at(-1) ?? null;
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

      const refreshed = (await sheets.getRows(SHEET_NAMES.workCollections))
        .filter((row) => row.collection_id === collectionId);
      if (refreshed.length > 1) {
        const latest = refreshed.at(-1);
        const dedupedAssets = mergeAssets(refreshed, []);
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
        const duplicateRows = refreshed
          .filter((row) => row.__rowNumber !== latest.__rowNumber)
          .map((row) => row.__rowNumber);
        await sheets.deleteRowsByNumbers(SHEET_NAMES.workCollections, duplicateRows);
      }

      return this.getCollectionById(collectionId);
    },
    async getOpenCollectionForChat(chatId) {
      const rows = await sheets.getRows(SHEET_NAMES.workCollections);
      const filtered = rows
        .filter((row) => String(row.chat_id) === String(chatId) && row.status === 'collecting')
        .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
      return rowToCollection(filtered[0] ?? null);
    },
    async listDueCollections(nowIso) {
      const rows = await sheets.getRows(SHEET_NAMES.workCollections);
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
      const rows = await sheets.getRows(SHEET_NAMES.workCollections);
      const existing = rows.filter((row) => row.collection_id === record.collection_id).at(-1);
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
      const rows = await sheets.getRows(SHEET_NAMES.callbackTokens);
      return rowToToken(rows.find((row) => row.token === token));
    },
    async listCallbackTokensByTokenSet(tokenSetId) {
      const rows = await sheets.getRows(SHEET_NAMES.callbackTokens);
      return rows
        .filter((row) => row.token_set_id === tokenSetId)
        .map(rowToToken);
    },
    async markCallbackUsed(token, updatedAt) {
      const rows = await sheets.getRows(SHEET_NAMES.callbackTokens);
      const row = rows.find((item) => item.token === token);
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
      const rows = await sheets.getRows(SHEET_NAMES.callbackTokens);
      const affected = rows.filter((row) => row.token_set_id === tokenSetId);
      for (const row of affected) {
        await sheets.updateRowByNumber(
          SHEET_NAMES.callbackTokens,
          row.__rowNumber,
          { ...row, superseded: 1, updated_at: updatedAt },
          SHEET_HEADERS[SHEET_NAMES.callbackTokens],
        );
      }
    },
    async cleanupCallbackTokens(nowIso) {
      const rows = await sheets.getRows(SHEET_NAMES.callbackTokens);
      const expired = rows.filter((row) => row.expires_at <= nowIso);
      await sheets.deleteRowsByNumbers(SHEET_NAMES.callbackTokens, expired.map((row) => row.__rowNumber));
      return expired.length;
    },

    async recordIdempotency(scope, payload, nowIso, expiresAt) {
      const idemKey = computeIdempotencyKey(scope, payload);
      const rows = await sheets.getRows(SHEET_NAMES.idempotencyKeys);
      if (rows.some((row) => row.idem_key === idemKey)) {
        return { idemKey, inserted: false };
      }
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
    },
    async hasIdempotency(idemKey) {
      const rows = await sheets.getRows(SHEET_NAMES.idempotencyKeys);
      return rows.some((row) => row.idem_key === idemKey);
    },
    async cleanupIdempotency(nowIso) {
      const rows = await sheets.getRows(SHEET_NAMES.idempotencyKeys);
      const expired = rows.filter((row) => row.expires_at && row.expires_at <= nowIso);
      await sheets.deleteRowsByNumbers(SHEET_NAMES.idempotencyKeys, expired.map((row) => row.__rowNumber));
      return expired.length;
    },

    async acquirePublishLock({ lockKey, jobId, queueId, createdAt, expiresAt }) {
      const rows = await sheets.getRows(SHEET_NAMES.publishLocks);
      const existing = rows.find((row) => row.lock_key === lockKey);
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
      const rows = await sheets.getRows(SHEET_NAMES.publishLocks);
      const row = rows.find((item) => item.lock_key === lockKey);
      if (row) {
        await sheets.deleteRowByNumber(SHEET_NAMES.publishLocks, row.__rowNumber);
      }
    },
    async cleanupPublishLocks(nowIso) {
      const rows = await sheets.getRows(SHEET_NAMES.publishLocks);
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
      const rows = await sheets.getRows(SHEET_NAMES.jobRuntimeCache);
      return rowToRuntime(rows.find((row) => row.job_id === jobId));
    },
    async listRuntimesByStatus(status) {
      const rows = await sheets.getRows(SHEET_NAMES.jobRuntimeCache);
      return rows
        .filter((row) => String(row.runtime_status ?? '') === String(status))
        .map(rowToRuntime);
    },
  };
}

export default createRepositories;
