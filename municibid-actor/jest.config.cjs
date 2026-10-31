module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/certification-tests/**/*.test.cjs'],
  clearMocks: true,
  modulePathIgnorePatterns: ['<rootDir>/.baseline/'],
  testPathIgnorePatterns: ['/node_modules/', '/.baseline/'],
};
