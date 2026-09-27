import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DataSource, type QueryRunner } from 'typeorm';
import { CompanyRegistrationService, type CompanyData } from './company-registration.service';

// Explicit local-only opt-in; all test data is rolled back, including approved companies.
const integration = process.env.RUN_COMPANY_DB_TESTS === '1' ? describe : describe.skip;
integration('company registration with real PostgreSQL transactions', () => {
  let database: DataSource;
  let runner: QueryRunner;
  let service: CompanyRegistrationService;
  beforeAll(async () => {
    database = new DataSource({
      type: 'postgres',
      host: '127.0.0.1',
      port: 54330,
      username: 'billing_core',
      database: 'billing_core',
      password: readFileSync('deploy/secrets/local/core_db_password', 'utf8').trim(),
    });
    await database.initialize();
    runner = database.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    service = new CompanyRegistrationService({
      transaction: (callback: (manager: typeof runner.manager) => unknown) =>
        callback(runner.manager),
      query: runner.query.bind(runner),
    } as unknown as DataSource);
  });
  afterAll(async () => {
    if (runner) {
      await runner.rollbackTransaction();
      await runner.release();
    }
    if (database?.isInitialized) await database.destroy();
  });
  it('isolates requests, preserves duplicate claims, and grants one verified company atomically', async () => {
    const subject = `test-${randomUUID()}`;
    const prefix = `20${String(Date.now()).slice(-8)}`;
    const remainder =
      11 -
      ([5, 4, 3, 2, 7, 6, 5, 4, 3, 2].reduce(
        (sum, weight, index) => sum + Number(prefix[index]) * weight,
        0,
      ) %
        11);
    const ruc = prefix + String(remainder === 10 ? 0 : remainder === 11 ? 1 : remainder);
    const data: CompanyData = {
      ruc,
      legalName: 'Integration test only',
      address: 'Test address',
      representativeName: 'Test applicant',
      relationship: 'representative',
      authorityExplanation: 'Test evidence only, all changes are rolled back.',
      series: 'F001',
      declaration: true,
    };
    const first = randomUUID(),
      second = randomUUID();
    await service.save({ subject, email: 'test@example.test' }, first, data);
    await service.save(
      { subject: 'other-test-subject', email: 'other@example.test' },
      second,
      data,
    );
    await expect(service.submit('other-test-subject', first)).rejects.toThrow('No encontramos');
    await service.submit(subject, first);
    await service.submit('other-test-subject', second);
    expect(await runner.query('SELECT id FROM issuers WHERE ruc=$1', [ruc])).toHaveLength(0);
    const approved = await service.decide(
      first,
      'independent-test-reviewer',
      'approve',
      'Test review completed',
      'Test evidence reference',
    );
    expect(approved.status).toBe('approved');
    expect(
      await runner.query(
        'SELECT id FROM organization_members WHERE organization_id=$1 AND subject=$2',
        [approved.organization_id, subject],
      ),
    ).toHaveLength(1);
    expect(
      await runner.query('SELECT id FROM issuer_series WHERE issuer_id=$1 AND organization_id=$2', [
        approved.issuer_id,
        approved.organization_id,
      ]),
    ).toHaveLength(1);
    expect(
      await runner.query('SELECT id FROM company_registration_events WHERE registration_id=$1', [
        first,
      ]),
    ).toHaveLength(2);
    await expect(
      service.decide(
        second,
        'independent-test-reviewer',
        'approve',
        'Test duplicate review',
        'Test evidence reference',
      ),
    ).rejects.toThrow('RUC ya está registrado');
    expect(
      await runner.query(
        'SELECT id FROM organization_members WHERE organization_id=$1 AND subject=$2',
        [approved.organization_id, 'other-test-subject'],
      ),
    ).toHaveLength(0);
  });
});
