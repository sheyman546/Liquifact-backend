'use strict';

const {
  createEscrowIndexer,
  normalizeEvent,
  persistEscrowEvent,
  runEscrowIndexerCycle,
  shouldReplaceProjection,
} = require('../../src/jobs/escrowIndexer');

function createInMemoryStore(initial = {}) {
  const state = {
    cursor: initial.cursor || null,
    eventsById: new Map(),
    projectionByInvoiceId: new Map(),
    saveCursorCalls: [],
  };

  return {
    _state: state,

    async loadCursor() {
      return state.cursor;
    },

    async saveCursor(cursor) {
      state.cursor = cursor;
      state.saveCursorCalls.push(cursor);
    },

    async findProjection(invoiceId) {
      return state.projectionByInvoiceId.get(invoiceId) || null;
    },

    async upsertEvent(_trx, event) {
      if (!state.eventsById.has(event.eventId)) {
        state.eventsById.set(event.eventId, event);
      }
    },

    async upsertProjection(_trx, event) {
      state.projectionByInvoiceId.set(event.invoiceId, {
        invoice_id: event.invoiceId,
        latest_event_id: event.eventId,
        latest_event_type: event.eventType,
        latest_ledger_sequence: event.ledgerSequence,
        latest_paging_token: event.pagingToken || null,
        latest_event_body: JSON.stringify(event.eventBody || {}),
        latest_observed_at: event.observedAt,
      });
    },
  };
}

function createTransactionRunner() {
  return async (handler) => handler({ fn: { now: () => new Date() } });
}

describe('escrowIndexer ordering and idempotency', () => {
  describe('normalizeEvent validation', () => {
    test('rejects non-object payload', () => {
      expect(() => normalizeEvent(null)).toThrow(/payload/i);
    });

    test('rejects invalid invoiceId', () => {
      expect(() =>
        normalizeEvent({ eventId: 'e1', invoiceId: '!!!', eventType: 'x', ledgerSequence: 1 })
      ).toThrow(/invoiceId/i);
    });

    test('rejects missing eventId/eventType', () => {
      expect(() =>
        normalizeEvent({ invoiceId: 'inv_1', eventType: 'x', ledgerSequence: 1 })
      ).toThrow(/eventId/i);
      expect(() =>
        normalizeEvent({ eventId: 'e1', invoiceId: 'inv_1', ledgerSequence: 1 })
      ).toThrow(/eventType/i);
    });

    test('rejects invalid ledgerSequence', () => {
      expect(() =>
        normalizeEvent({ eventId: 'e1', invoiceId: 'inv_1', eventType: 'x', ledgerSequence: 0 })
      ).toThrow(/ledgerSequence/i);
    });

    test('rejects when invoiceId is missing/empty', () => {
      expect(() =>
        normalizeEvent({ eventId: 'e1', eventType: 'x', ledgerSequence: 1 })
      ).toThrow(/invoiceId/i);
    });

    test('keeps optional chain pointers when present', () => {
      const event = normalizeEvent({
        eventId: 'e1',
        invoiceId: 'inv_1',
        eventType: 'escrow_created',
        ledgerSequence: 1,
        pagingToken: '1',
        contractId: 'CABCDE',
        txHash: 'TXHASH',
        observedAt: '2026-01-01T00:00:00Z',
        eventBody: { hello: 'world' },
      });

      expect(event.contractId).toBe('CABCDE');
      expect(event.txHash).toBe('TXHASH');
      expect(event.observedAt).toBe('2026-01-01T00:00:00Z');
    });
  });

  describe('shouldReplaceProjection', () => {
    test('returns true when no current projection exists', () => {
      expect(shouldReplaceProjection(null, { ledgerSequence: 10, pagingToken: '1' })).toBe(true);
    });

    test('newer ledger replaces older projection', () => {
      const current = { latest_ledger_sequence: 100, latest_paging_token: '10' };
      expect(shouldReplaceProjection(current, { ledgerSequence: 101, pagingToken: '0' })).toBe(true);
    });

    test('older ledger is ignored', () => {
      const current = { latest_ledger_sequence: 100, latest_paging_token: '10' };
      expect(shouldReplaceProjection(current, { ledgerSequence: 99, pagingToken: '999' })).toBe(false);
    });

    test('equal ledger uses paging-token tiebreaker: greater token replaces', () => {
      const current = { latest_ledger_sequence: 100, latest_paging_token: '10' };
      expect(shouldReplaceProjection(current, { ledgerSequence: 100, pagingToken: '11' })).toBe(true);
    });

    test('equal ledger uses paging-token tiebreaker: equal/smaller token does not replace', () => {
      const current = { latest_ledger_sequence: 100, latest_paging_token: '10' };
      expect(shouldReplaceProjection(current, { ledgerSequence: 100, pagingToken: '10' })).toBe(false);
      expect(shouldReplaceProjection(current, { ledgerSequence: 100, pagingToken: '09' })).toBe(false);
    });

    test('handles null projection fields safely', () => {
      const current = { latest_ledger_sequence: null, latest_paging_token: null };
      expect(shouldReplaceProjection(current, { ledgerSequence: 1, pagingToken: '1' })).toBe(true);
      expect(shouldReplaceProjection(current, { ledgerSequence: 0, pagingToken: '1' })).toBe(true);
    });

    test('treats missing pagingToken as empty string for tiebreak', () => {
      const current = { latest_ledger_sequence: 100, latest_paging_token: '10' };
      expect(shouldReplaceProjection(current, { ledgerSequence: 100 })).toBe(false);
    });
  });

  describe('persistEscrowEvent', () => {
    test('upserts projection when event is newer', async () => {
      const store = createInMemoryStore();
      const transactionRunner = createTransactionRunner();

      await persistEscrowEvent(
        { store, transactionRunner },
        {
          eventId: 'evt-1',
          invoiceId: 'inv_1',
          eventType: 'escrow_created',
          ledgerSequence: 10,
          pagingToken: '10',
          eventBody: { ok: true },
          observedAt: '2026-01-01T00:00:00Z',
        }
      );

      const projection = await store.findProjection('inv_1');
      expect(projection).toBeTruthy();
      expect(projection.latest_event_id).toBe('evt-1');
      expect(store._state.eventsById.has('evt-1')).toBe(true);
    });

    test('older event does not replace projection (but is still idempotently recorded)', async () => {
      const store = createInMemoryStore();
      const transactionRunner = createTransactionRunner();

      await persistEscrowEvent(
        { store, transactionRunner },
        {
          eventId: 'evt-new',
          invoiceId: 'inv_1',
          eventType: 'escrow_updated',
          ledgerSequence: 20,
          pagingToken: '20',
        }
      );

      await persistEscrowEvent(
        { store, transactionRunner },
        {
          eventId: 'evt-old',
          invoiceId: 'inv_1',
          eventType: 'escrow_created',
          ledgerSequence: 19,
          pagingToken: '999',
        }
      );

      const projection = await store.findProjection('inv_1');
      expect(projection.latest_event_id).toBe('evt-new');
      expect(store._state.eventsById.has('evt-old')).toBe(true);
    });

    test('duplicate event_id is idempotent (no projection churn)', async () => {
      const store = createInMemoryStore();
      const transactionRunner = createTransactionRunner();

      await persistEscrowEvent(
        { store, transactionRunner },
        {
          eventId: 'evt-dup',
          invoiceId: 'inv_1',
          eventType: 'escrow_created',
          ledgerSequence: 10,
          pagingToken: '10',
        }
      );

      const firstProjection = await store.findProjection('inv_1');

      await persistEscrowEvent(
        { store, transactionRunner },
        {
          eventId: 'evt-dup',
          invoiceId: 'inv_1',
          eventType: 'escrow_created',
          ledgerSequence: 10,
          pagingToken: '10',
        }
      );

      const secondProjection = await store.findProjection('inv_1');
      expect(secondProjection.latest_event_id).toBe('evt-dup');
      expect(store._state.eventsById.size).toBe(1);
      expect(secondProjection).toEqual(firstProjection);
    });

    test('throws on invalid event payload (normalizeEvent)', async () => {
      const store = createInMemoryStore();
      const transactionRunner = createTransactionRunner();

      await expect(
        persistEscrowEvent(
          { store, transactionRunner },
          { eventId: 'evt-bad', invoiceId: 'inv_1', eventType: 'x', ledgerSequence: 0 }
        )
      ).rejects.toThrow(/ledgerSequence/i);
    });
  });

  describe('runEscrowIndexerCycle', () => {
    test('counts processed vs skipped; invalid events do not abort cycle', async () => {
      const store = createInMemoryStore({ cursor: 'cur-0' });
      const transactionRunner = createTransactionRunner();
      const fetchEscrowEvents = async () => ({
        events: [
          // valid
          { eventId: 'evt-1', invoiceId: 'inv_1', eventType: 'escrow_created', ledgerSequence: 1, pagingToken: '1' },
          // invalid invoiceId format
          { eventId: 'evt-2', invoiceId: '!!!', eventType: 'escrow_created', ledgerSequence: 2, pagingToken: '2' },
          // valid
          { eventId: 'evt-3', invoiceId: 'inv_2', eventType: 'escrow_updated', ledgerSequence: 3, pagingToken: '3' },
        ],
        nextCursor: 'cur-1',
      });

      const log = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };

      const summary = await runEscrowIndexerCycle({
        store,
        fetchEscrowEvents,
        transactionRunner,
        log,
        batchSize: 100,
      });

      expect(summary.processed).toBe(2);
      expect(summary.skipped).toBe(1);
      expect(log.warn).toHaveBeenCalled();
      expect(store._state.saveCursorCalls).toEqual(['cur-1']);
    });

    test('cursor only advances when changed', async () => {
      const store = createInMemoryStore({ cursor: 'cur-0' });
      const transactionRunner = createTransactionRunner();

      const fetchEscrowEventsSameCursor = async () => ({
        events: [{ eventId: 'evt-1', invoiceId: 'inv_1', eventType: 'escrow_created', ledgerSequence: 1, pagingToken: '1' }],
        nextCursor: 'cur-0',
      });

      const summary = await runEscrowIndexerCycle({
        store,
        fetchEscrowEvents: fetchEscrowEventsSameCursor,
        transactionRunner,
        log: { warn: jest.fn() },
        batchSize: 100,
      });

      expect(summary.cursorBefore).toBe('cur-0');
      expect(summary.cursorAfter).toBe('cur-0');
      expect(store._state.saveCursorCalls).toEqual([]);
    });

    test('does not save cursor when nextCursor is null/unchanged', async () => {
      const store = createInMemoryStore({ cursor: null });
      const transactionRunner = createTransactionRunner();
      const fetchEscrowEvents = async () => ({
        events: [],
        nextCursor: null,
      });

      const summary = await runEscrowIndexerCycle({
        store,
        fetchEscrowEvents,
        transactionRunner,
        log: { warn: jest.fn() },
        batchSize: 100,
      });

      expect(summary.processed).toBe(0);
      expect(summary.skipped).toBe(0);
      expect(summary.cursorBefore).toBeNull();
      expect(summary.cursorAfter).toBeNull();
      expect(store._state.saveCursorCalls).toEqual([]);
    });

    test('uses default logger + batchSize when not provided', async () => {
      const store = createInMemoryStore({ cursor: 'cur-0' });
      const transactionRunner = createTransactionRunner();
      const fetchEscrowEvents = async ({ cursor, limit }) => {
        expect(cursor).toBe('cur-0');
        expect(limit).toBe(100);
        return {
          events: [{ eventId: 'evt-1', invoiceId: 'inv_1', eventType: 'escrow_created', ledgerSequence: 1, pagingToken: '1' }],
          nextCursor: 'cur-1',
        };
      };

      const summary = await runEscrowIndexerCycle({
        store,
        fetchEscrowEvents,
        transactionRunner,
      });

      expect(summary.processed).toBe(1);
      expect(store._state.saveCursorCalls).toEqual(['cur-1']);
    });
  });

  describe('createEscrowIndexer (DI hooks)', () => {
    test('runCycle is re-entrant safe (skips overlapping cycles)', async () => {
      const store = createInMemoryStore({ cursor: null });
      const transactionRunner = createTransactionRunner();
      const fetchEscrowEvents = async () => ({
        events: [{ eventId: 'evt-1', invoiceId: 'inv_1', eventType: 'escrow_created', ledgerSequence: 1, pagingToken: '1' }],
        nextCursor: 'cur-1',
      });

      let resolveBlocker;
      const blocker = new Promise((r) => { resolveBlocker = r; });

      const slowFetch = async (params) => {
        await blocker;
        return fetchEscrowEvents(params);
      };

      const indexer = createEscrowIndexer({
        store,
        fetchEscrowEvents: slowFetch,
        transactionRunner,
        pollIntervalMs: 10,
        log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      });

      const p1 = indexer.runCycle();
      const p2 = indexer.runCycle();
      resolveBlocker();

      const first = await p1;
      const second = await p2;
      expect(first).toBeTruthy();
      expect(second).toBeNull();
    });

    test('start/stop are idempotent', async () => {
      jest.useFakeTimers();
      const store = createInMemoryStore({ cursor: null });
      const transactionRunner = createTransactionRunner();
      const fetchEscrowEvents = async () => ({ events: [], nextCursor: null });

      const indexer = createEscrowIndexer({
        store,
        fetchEscrowEvents,
        transactionRunner,
        pollIntervalMs: 10,
        log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      });

      indexer.start();
      indexer.start();
      jest.advanceTimersByTime(25);
      indexer.stop();
      indexer.stop();
      jest.useRealTimers();
    });

    test('runCycle logs error and returns null on failure', async () => {
      const store = createInMemoryStore({ cursor: null });
      const transactionRunner = createTransactionRunner();
      const fetchEscrowEvents = async () => {
        throw new Error('horizon down');
      };

      const indexer = createEscrowIndexer({
        store,
        fetchEscrowEvents,
        transactionRunner,
        pollIntervalMs: 10,
      });

      const result = await indexer.runCycle();
      expect(result).toBeNull();
    });

    test('runCycle success path works without custom logger', async () => {
      const store = createInMemoryStore({ cursor: null });
      const transactionRunner = createTransactionRunner();
      const fetchEscrowEvents = async () => ({ events: [], nextCursor: null });

      const indexer = createEscrowIndexer({
        store,
        fetchEscrowEvents,
        transactionRunner,
      });

      const result = await indexer.runCycle();
      expect(result).toMatchObject({ processed: 0, skipped: 0 });
    });
  });
});
