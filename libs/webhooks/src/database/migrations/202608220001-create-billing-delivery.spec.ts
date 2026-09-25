import type { QueryRunner } from 'typeorm';

import { CreateBillingDelivery1787356800000 } from './202608220001-create-billing-delivery';

describe('CreateBillingDelivery1787356800000', () => {
  it('creates durable subscriptions, encrypted versions and delivery history', async () => {
    const executedSql: string[] = [];
    const queryRunner = {
      query: jest.fn((sql: string) => {
        executedSql.push(sql);
        return Promise.resolve();
      }),
    } as unknown as QueryRunner;

    await new CreateBillingDelivery1787356800000().up(queryRunner);

    const schema = executedSql.join('\n');
    expect(schema).toContain('CREATE TABLE webhook_subscriptions');
    expect(schema).toContain('CREATE TABLE webhook_secret_versions');
    expect(schema).toContain('encrypted_envelope jsonb NOT NULL');
    expect(schema).toContain('uq_webhook_secret_versions_active');
    expect(schema).toContain('CREATE TABLE webhook_deliveries');
    expect(schema).toContain('raw_body text NOT NULL');
    expect(schema).toContain('lock_token uuid');
    expect(schema).toContain('CREATE TABLE webhook_delivery_attempts');
    expect(schema).toContain('CREATE TABLE webhook_dead_letters');
    expect(schema).toContain('UNIQUE (organization_id, event_id, subscription_id)');
    expect(schema).toContain('FOREIGN KEY (organization_id, subscription_id)');
    expect(schema).not.toMatch(/secret\s+(text|varchar)/iu);
  });
});
