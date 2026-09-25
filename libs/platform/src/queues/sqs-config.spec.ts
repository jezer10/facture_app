import { sqsConfiguration } from './sqs-config';
const env = { AWS_REGION: 'us-east-1', SQS_ACCOUNT_ID: '123456789012' };
it('uses AWS default credentials without embedded keys', () => {
  expect(sqsConfiguration(env).client.credentials).toBeUndefined();
});
it('requires an explicit account and region', () => {
  expect(() => sqsConfiguration({})).toThrow('AWS_REGION');
  expect(() => sqsConfiguration({ AWS_REGION: 'us-east-1' })).toThrow('SQS_ACCOUNT_ID');
});
it('uses isolated emulator credentials only on local development endpoints', () => {
  expect(
    sqsConfiguration({ ...env, SQS_ENDPOINT: 'http://127.0.0.1:59324' }).client.credentials,
  ).toEqual({ accessKeyId: 'local', secretAccessKey: 'local' });
});
it.each([
  'http://evil.example',
  'https://localhost',
  'http://localhost/path',
  'http://user:secret@localhost',
])('rejects unsafe emulator override %s', (endpoint) => {
  expect(() => sqsConfiguration({ ...env, SQS_ENDPOINT: endpoint })).toThrow('SQS_ENDPOINT');
});
it('forbids an emulator in production', () => {
  expect(() =>
    sqsConfiguration({ ...env, NODE_ENV: 'production', SQS_ENDPOINT: 'http://localhost:59324' }),
  ).toThrow('SQS_ENDPOINT');
});
