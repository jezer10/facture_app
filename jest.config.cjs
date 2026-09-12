module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/{apps,libs,test}/**/*.spec.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  moduleNameMapper: {
    '^@app/(.+)$': '<rootDir>/libs/$1/src',
  },
  collectCoverageFrom: ['{apps,libs}/**/*.ts', '!**/index.ts', '!**/*.module.ts'],
  coverageDirectory: 'coverage',
  clearMocks: true,
};
