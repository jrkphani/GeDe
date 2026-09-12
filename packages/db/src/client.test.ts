import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { POOL_TIMEOUTS, poolConfigFromEnv } from './client.js';

const base = {
  PGHOST: 'db.internal',
  PGPORT: '5432',
  PGUSER: 'gede',
  PGPASSWORD: 'secret',
  PGDATABASE: 'gede',
};

describe('poolConfigFromEnv', () => {
  test('LOAD-06 reads the PG* variables and defaults to no TLS', () => {
    const config = poolConfigFromEnv(base);
    expect(config).toMatchObject({
      host: 'db.internal',
      port: 5432,
      user: 'gede',
      password: 'secret',
      database: 'gede',
    });
    expect(config.ssl).toBeUndefined();
  });

  test('LOAD-06 verify-full pins the CA bundle and rejects unauthorised certificates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gede-ca-'));
    const caPath = join(dir, 'ca.pem');
    writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n');
    const config = poolConfigFromEnv({ ...base, PGSSLMODE: 'verify-full', PGSSLROOTCERT: caPath });
    expect(config.ssl).toEqual({
      ca: '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n',
      rejectUnauthorized: true,
    });
  });

  test('LOAD-06 verify-full without a CA path is an error, and unknown modes are rejected', () => {
    expect(() => poolConfigFromEnv({ ...base, PGSSLMODE: 'verify-full' })).toThrow(/PGSSLROOTCERT/);
    expect(() => poolConfigFromEnv({ ...base, PGSSLMODE: 'prefer' })).toThrow(/PGSSLMODE/);
    expect(() => poolConfigFromEnv({ ...base, PGHOST: '' })).toThrow(/PGHOST/);
    expect(() => poolConfigFromEnv({ ...base, PGPORT: 'x' })).toThrow(/PGPORT/);
  });

  test('LOAD-06 production refuses any mode but verify-full (#42)', () => {
    const prod = { ...base, NODE_ENV: 'production' };
    expect(() => poolConfigFromEnv(prod)).toThrow(/verify-full when NODE_ENV=production/);
    expect(() => poolConfigFromEnv({ ...prod, PGSSLMODE: 'disable' })).toThrow(/verify-full/);
    expect(() => poolConfigFromEnv({ ...prod, PGSSLMODE: 'require' })).toThrow(/verify-full/);
    // Anything but production keeps the local defaults.
    expect(poolConfigFromEnv({ ...base, NODE_ENV: 'development' }).ssl).toBeUndefined();
  });

  test('LOAD-06 every pooled session carries statement, lock and idle-in-transaction timeouts (#42)', () => {
    expect(poolConfigFromEnv(base)).toMatchObject({
      statement_timeout: POOL_TIMEOUTS.statementTimeoutMs,
      lock_timeout: POOL_TIMEOUTS.lockTimeoutMs,
      idle_in_transaction_session_timeout: POOL_TIMEOUTS.idleInTransactionSessionTimeoutMs,
    });
  });
});
