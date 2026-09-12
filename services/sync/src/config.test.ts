import { describe, expect, test } from 'vitest';

import { ConfigError, loadConfig } from './config.js';

const required = {
  COGNITO_USER_POOL_ID: 'ap-southeast-1_abc',
  COGNITO_CLIENT_IDS: 'client',
  COGNITO_REGION: 'ap-southeast-1',
  DOCS_BUCKET: 'bucket',
  WEB_ORIGIN: 'https://gede.work',
};

describe('loadConfig', () => {
  test('LOAD-06 applies the documented defaults', () => {
    const config = loadConfig(required);
    expect(config).toMatchObject({
      PORT: 3000,
      SNAPSHOT_EVERY_UPDATES: 500,
      SNAPSHOT_IDLE_MS: 300_000,
      ROOM_IDLE_MS: 600_000,
      DOCS_PREFIX: '',
      LOG_LEVEL: 'info',
      NODE_ENV: 'production',
    });
  });

  test('AUTH-01 COGNITO_CLIENT_IDS is a comma-separated allow-list; blanks are dropped and an empty list is refused', () => {
    expect(loadConfig(required).COGNITO_CLIENT_IDS).toEqual(['client']);
    expect(
      loadConfig({ ...required, COGNITO_CLIENT_IDS: ' spa-client, gede-e2e ,, ' })
        .COGNITO_CLIENT_IDS,
    ).toEqual(['spa-client', 'gede-e2e']);
    expect(() => loadConfig({ ...required, COGNITO_CLIENT_IDS: ' , ' })).toThrow(ConfigError);
  });

  test('LOAD-06 coerces numbers and normalises the S3 prefix', () => {
    const config = loadConfig({
      ...required,
      PORT: '8080',
      SNAPSHOT_EVERY_UPDATES: '3',
      DOCS_PREFIX: 'docs',
    });
    expect(config.PORT).toBe(8080);
    expect(config.SNAPSHOT_EVERY_UPDATES).toBe(3);
    expect(config.DOCS_PREFIX).toBe('docs/');
  });

  test('LOAD-05 the byte limits must agree: a burst below one frame, or a log bound above the document ceiling, is refused at boot (#99)', () => {
    expect(loadConfig(required)).toMatchObject({
      WS_MAX_UPDATE_BYTES: 2 * 1024 * 1024,
      WS_BYTES_BURST: 4 * 1024 * 1024,
      DOC_LOG_MAX_BYTES: 8 * 1024 * 1024,
      DOC_MAX_BYTES: 64 * 1024 * 1024,
      WS_MAX_SOCKETS_PER_USER: 16,
      COGNITO_ERASE_IDENTITY: false,
    });
    expect(() => loadConfig({ ...required, WS_BYTES_BURST: '1000' })).toThrow(
      /WS_BYTES_BURST must be at least WS_MAX_UPDATE_BYTES/,
    );
    expect(() =>
      loadConfig({ ...required, DOC_LOG_MAX_BYTES: '100', DOC_MAX_BYTES: '50' }),
    ).toThrow(/DOC_LOG_MAX_BYTES must not exceed DOC_MAX_BYTES/);
    expect(loadConfig({ ...required, COGNITO_ERASE_IDENTITY: 'true' }).COGNITO_ERASE_IDENTITY).toBe(
      true,
    );
  });

  test('LOAD-06 names every missing or invalid variable and has no auth bypass', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    try {
      loadConfig({ ...required, WEB_ORIGIN: 'not a url', PORT: '0' });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const issues = (error as ConfigError).issues.join('\n');
      expect(issues).toContain('WEB_ORIGIN');
      expect(issues).toContain('PORT');
    }
    expect(Object.keys(loadConfig(required))).not.toContain('DEV_JWT_BYPASS');
  });
});
