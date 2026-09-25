import { nextOutboxRetry } from './outbox-retry-policy';

describe('nextOutboxRetry', () => {
  const now = new Date('2026-08-22T12:00:00.000Z');

  it('moves exhausted rapid retries into the durable retrying state', () => {
    expect(nextOutboxRetry(9, now)).toEqual({
      availableAt: new Date('2026-08-22T12:01:00.000Z'),
      status: 'pending',
    });
    expect(nextOutboxRetry(10, now)).toEqual({
      availableAt: new Date('2026-08-22T12:01:00.000Z'),
      status: 'retrying',
    });
  });

  it('keeps retrying indefinitely with a bounded degraded backoff', () => {
    expect(nextOutboxRetry(30, now)).toEqual({
      availableAt: new Date('2026-08-22T12:15:00.000Z'),
      status: 'retrying',
    });
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects invalid attempt count %s', (attempts) => {
    expect(() => nextOutboxRetry(attempts, now)).toThrow(
      'Outbox attempts must be a positive integer',
    );
  });
});
