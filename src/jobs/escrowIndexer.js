'use strict';

const db = require('../db/knex');
const logger = require('../logger');

const INVOICE_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;
const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_BATCH_SIZE = 100;

function normalizeEvent(rawEvent) {
  if (!rawEvent || typeof rawEvent !== 'object') {
    throw new Error('Event payload must be an object.');
  }

  const invoiceId = String(rawEvent.invoiceId || '').trim();
  const eventId = String(rawEvent.eventId || '').trim();
  const eventType = String(rawEvent.eventType || '').trim();
  const pagingToken = String(rawEvent.pagingToken || '').trim();
  const ledgerSequence = Number(rawEvent.ledgerSequence);

  if (!INVOICE_ID_REGEX.test(invoiceId)) {
    throw new Error('Invalid invoiceId format.');
  }
  if (!eventId) {
    throw new Error('eventId is required.');
  }
  if (!eventType) {
    throw new Error('eventType is required.');
  }
  if (!Number.isInteger(ledgerSequence) || ledgerSequence <= 0) {
    throw new Error('ledgerSequence must be a positive integer.');
  }

  return {
    eventId,
    invoiceId,
    eventType,
    ledgerSequence,
    pagingToken,
    contractId: rawEvent.contractId ? String(rawEvent.contractId) : null,
    txHash: rawEvent.txHash ? String(rawEvent.txHash) : null,
    eventBody: rawEvent.eventBody || {},
    observedAt: rawEvent.observedAt || new Date().toISOString(),
  };
}

/* istanbul ignore next -- DB-backed store is exercised in integration tests; unit tests inject in-memory store via DI. */
function createKnexEscrowEventStore(knex) {
  return {
    async loadCursor() {
      const row = await knex('escrow_indexer_state')
        .where({ key: 'horizon_cursor' })
        .first();
      return row ? row.value : null;
    },

    async saveCursor(cursor) {
      await knex('escrow_indexer_state')
        .insert({ key: 'horizon_cursor', value: cursor, updated_at: knex.fn.now() })
        .onConflict('key')
        .merge({ value: cursor, updated_at: knex.fn.now() });
    },

    async findProjection(invoiceId) {
      return knex('escrow_event_projection').where({ invoice_id: invoiceId }).first();
    },

    async upsertEvent(trx, event) {
      await trx('escrow_events')
        .insert({
          event_id: event.eventId,
          invoice_id: event.invoiceId,
          event_type: event.eventType,
          ledger_sequence: event.ledgerSequence,
          paging_token: event.pagingToken || null,
          contract_id: event.contractId,
          tx_hash: event.txHash,
          event_body: JSON.stringify(event.eventBody || {}),
          observed_at: event.observedAt,
        })
        .onConflict('event_id')
        .ignore();
    },

    async upsertProjection(trx, event) {
      await trx('escrow_event_projection')
        .insert({
          invoice_id: event.invoiceId,
          latest_event_id: event.eventId,
          latest_event_type: event.eventType,
          latest_ledger_sequence: event.ledgerSequence,
          latest_paging_token: event.pagingToken || null,
          latest_event_body: JSON.stringify(event.eventBody || {}),
          latest_observed_at: event.observedAt,
          updated_at: trx.fn.now(),
        })
        .onConflict('invoice_id')
        .merge({
          latest_event_id: event.eventId,
          latest_event_type: event.eventType,
          latest_ledger_sequence: event.ledgerSequence,
          latest_paging_token: event.pagingToken || null,
          latest_event_body: JSON.stringify(event.eventBody || {}),
          latest_observed_at: event.observedAt,
          updated_at: trx.fn.now(),
        });
    },
  };
}

function shouldReplaceProjection(currentProjection, event) {
  if (!currentProjection) {
    return true;
  }

  const currentLedger = Number(currentProjection.latest_ledger_sequence || 0);
  if (event.ledgerSequence > currentLedger) {
    return true;
  }
  if (event.ledgerSequence < currentLedger) {
    return false;
  }

  const currentToken = String(currentProjection.latest_paging_token || '');
  const nextToken = String(event.pagingToken || '');
  return nextToken > currentToken;
}

async function persistEscrowEvent({ store, transactionRunner }, rawEvent) {
  const event = normalizeEvent(rawEvent);

  await transactionRunner(async (trx) => {
    await store.upsertEvent(trx, event);
    const projection = await store.findProjection(event.invoiceId);
    if (shouldReplaceProjection(projection, event)) {
      await store.upsertProjection(trx, event);
    }
  });

  return event;
}

/* istanbul ignore next -- network/Horizon integration tested separately; unit tests inject fetchEscrowEvents via DI. */
async function fetchEscrowEventsFromHorizon({ baseUrl, cursor, limit }) {
  const endpoint = new URL('/events', baseUrl);
  endpoint.searchParams.set('order', 'asc');
  endpoint.searchParams.set('limit', String(limit));
  if (cursor) {
    endpoint.searchParams.set('cursor', cursor);
  }

  const response = await fetch(endpoint, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Horizon events request failed (${response.status}): ${text}`);
  }

  const payload = await response.json();
  const records = payload && payload._embedded && Array.isArray(payload._embedded.records)
    ? payload._embedded.records
    : [];

  const events = records.map((record) => ({
    eventId: String(record.id || ''),
    invoiceId: record.contract_id || '',
    eventType: record.type || 'contract_event',
    ledgerSequence: Number(record.ledger || 0),
    pagingToken: String(record.paging_token || ''),
    contractId: record.contract_id || null,
    txHash: record.tx_hash || null,
    eventBody: record,
    observedAt: new Date().toISOString(),
  }));

  const nextCursor = records.length > 0
    ? String(records[records.length - 1].paging_token || cursor || '')
    : cursor || null;

  return { events, nextCursor };
}

async function runEscrowIndexerCycle({
  store,
  fetchEscrowEvents,
  transactionRunner,
  log = logger,
  batchSize = DEFAULT_BATCH_SIZE,
}) {
  const cursor = await store.loadCursor();
  const { events, nextCursor } = await fetchEscrowEvents({ cursor, limit: batchSize });

  let processed = 0;
  let skipped = 0;

  for (const rawEvent of events) {
    try {
      await persistEscrowEvent({ store, transactionRunner }, rawEvent);
      processed += 1;
    } catch (error) {
      skipped += 1;
      log.warn({ err: error, eventId: rawEvent && rawEvent.eventId }, 'Skipping invalid escrow event.');
    }
  }

  if (nextCursor && nextCursor !== cursor) {
    await store.saveCursor(nextCursor);
  }

  return { processed, skipped, cursorBefore: cursor, cursorAfter: nextCursor || cursor || null };
}

function createEscrowIndexer(options = {}) {
  /* istanbul ignore next -- default DB-backed wiring exercised in integration tests; unit tests inject store via DI. */
  const store = options.store || createKnexEscrowEventStore(options.db || db);
  const horizonBaseUrl = options.horizonBaseUrl || process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
  const fetchEscrowEvents =
    options.fetchEscrowEvents ||
    /* istanbul ignore next -- default Horizon fetch exercised in integration tests; unit tests inject fetchEscrowEvents via DI. */
    ((params) => fetchEscrowEventsFromHorizon({
      baseUrl: horizonBaseUrl,
      cursor: params.cursor,
      limit: params.limit,
    }));
  const transactionRunner =
    options.transactionRunner ||
    /* istanbul ignore next -- default transaction runner exercised with knex; unit tests inject transactionRunner via DI. */
    ((handler) => (options.db || db).transaction(handler));
  const pollIntervalMs = Number(options.pollIntervalMs || process.env.ESCROW_INDEXER_POLL_INTERVAL_MS || DEFAULT_POLL_INTERVAL_MS);

  let timer = null;
  let running = false;

  const runCycle = async () => {
    if (running) {
      return null;
    }
    running = true;
    try {
      const summary = await runEscrowIndexerCycle({
        store,
        fetchEscrowEvents,
        transactionRunner,
        log: options.log || logger,
        batchSize: Number(process.env.ESCROW_INDEXER_BATCH_SIZE || DEFAULT_BATCH_SIZE),
      });
      (options.log || logger).info(summary, 'Escrow indexer cycle completed.');
      return summary;
    } catch (error) {
      (options.log || logger).error({ err: error }, 'Escrow indexer cycle failed.');
      return null;
    } finally {
      running = false;
    }
  };

  const start = () => {
    if (timer) {
      return;
    }
    runCycle().catch(() => {});
    timer = setInterval(() => {
      runCycle().catch(() => {});
    }, pollIntervalMs);
  };

  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  return { start, stop, runCycle };
}

module.exports = {
  createEscrowIndexer,
  createKnexEscrowEventStore,
  fetchEscrowEventsFromHorizon,
  normalizeEvent,
  persistEscrowEvent,
  runEscrowIndexerCycle,
  shouldReplaceProjection,
};
