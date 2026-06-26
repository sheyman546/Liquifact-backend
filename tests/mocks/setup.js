
process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long-string-for-jest';
process.env.ESCROW_ADDR_BY_INVOICE = JSON.stringify({
  mappings: [{ invoiceId: 'inv_001', escrowAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', environment: 'test', isActive: true }],
  defaultEnvironment: 'test',
  allowlistEnabled: true,
  cacheEnabled: true,
  cacheTtlSeconds: 300,
});
require('../../src/config').validate();

let mockInMemoryDb = [];
let mockCurrentTable = null;

jest.mock('../../src/db/knex', () => {
  const auditLogEvents = [];
  let queryWheres = {};
  let mockCurrentTable;
  let _lastInserted = null;
  let _lastUpdateFields = null;

  const m = jest.fn((table) => {
    mockCurrentTable = table;
    queryWheres = {};
    _lastInserted = null;
    _lastUpdateFields = null;
    return m;
  });

  m.where = jest.fn((field, value) => {
    if (typeof field === "string") {
      queryWheres[field] = value;
    }
    return m;
  });
  m.whereNotIn = jest.fn().mockReturnThis();
  m.whereNull = jest.fn().mockReturnThis();
  m.whereIn = jest.fn().mockReturnThis();
  m.leftJoin = jest.fn().mockReturnThis();
  m.orderBy = jest.fn().mockReturnThis();
  m.limit = jest.fn().mockReturnThis();
  m.offset = jest.fn().mockReturnThis();
  m.select = jest.fn().mockReturnThis();
  m.insert = jest.fn((data) => {
    const rows = Array.isArray(data) ? data : [data];
    const inserted = rows.map((r) => ({
      id: Math.random().toString(),
      created_at: new Date().toISOString(),
      ...r,
    }));
    _lastInserted = inserted;
    auditLogEvents.push(...inserted);
    if (mockCurrentTable === "audit_log_events") {
      mockInMemoryDb.push(...inserted);
    }
    return m;
  });
  m.update = jest.fn((fields) => {
    _lastUpdateFields = fields;
    const updatedRows = [{ id: 'updated-id', ...fields, updated_at: new Date().toISOString() }];
    m._resolveValue = Promise.resolve(updatedRows);
    return m;
  });
  m.del = jest.fn(() => {
    auditLogEvents.length = 0;
    return Promise.resolve(1);
  });
  m.first = jest.fn().mockResolvedValue({ id: 'test', kyc_status: 'approved' });
  m.returning = jest.fn(() => {
    return Promise.resolve(_lastInserted || []);
  });
  m.delete = jest.fn(() => {
    auditLogEvents.length = 0;
    return Promise.resolve(1);
  });
  m.andWhere = jest.fn().mockReturnThis();
  m.orWhere = jest.fn().mockReturnThis();
  m.count = jest.fn().mockResolvedValue([{ count: 25 }]);
  m.raw = jest.fn();
  m.then = jest.fn((onFulfilled) => {
    if (m._resolveValue) {
      const rv = m._resolveValue;
      m._resolveValue = null;
      return rv.then(onFulfilled);
    }
    if (mockCurrentTable === "audit_log_events") {
      return Promise.resolve(mockInMemoryDb).then(onFulfilled);
    }
    return Promise.resolve([]).then(onFulfilled);
  });

  m.offset = jest.fn(() => {
    let results = [...auditLogEvents];

    if (queryWheres.target_id) {
      results = results.filter((r) => r.target_id === queryWheres.target_id);
    }

    if (queryWheres.target_type) {
      results = results.filter((r) => r.target_type === queryWheres.target_type);
    }

    if (queryWheres.actor_id) {
      results = results.filter((r) => r.actor_id === queryWheres.actor_id);
    }

    if (queryWheres.action) {
      results = results.filter((r) => r.action === queryWheres.action);
    }

    results.reverse();
    return Promise.resolve(results);
  });
  return m;
}, { virtual: true });

jest.mock('@stellar/stellar-sdk', () => ({
  nativeToScVal: jest.fn(),
  Address: {
    fromString: jest.fn(() => ({
      toScVal: jest.fn(),
    })),
  },
  Keypair: {
    fromSecret: jest.fn(() => ({
      publicKey: jest.fn(() => 'mock-public-key'),
      sign: jest.fn(),
    })),
  },
}), { virtual: true });

jest.mock('@stellar/stellar-sdk/rpc', () => ({
  Server: jest.fn().mockImplementation(() => ({
    getTransaction: jest.fn(),
    sendTransaction: jest.fn(),
    simulateTransaction: jest.fn(),
    // Required by the issue #436 contract-existence preflight in
    // src/services/escrowSubmit.js (`_preflightContractExists`).
    getLedgerEntry: jest.fn(),
    getContractData: jest.fn(),
    prepareTransaction: jest.fn(),
  })),
}), { virtual: true });

