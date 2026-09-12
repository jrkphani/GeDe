import { describe, expect, test } from 'vitest';

import { ConfigError, loadConfig } from './config.js';

const required = {
  COGNITO_USER_POOL_ID: 'ap-southeast-1_abc',
  COGNITO_CLIENT_ID: 'client',
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
