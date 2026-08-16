/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {}],
  },
  // Stack snapshots assert TEMPLATE STRUCTURE, not build output — see
  // test/assetHashSerializer.ts for why the bundled-Lambda asset hash must not
  // be part of the contract.
  snapshotSerializers: ['<rootDir>/test/assetHashSerializer.js'],
};
