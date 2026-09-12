import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { poolConfigFromEnv } from './client.js';

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
});
