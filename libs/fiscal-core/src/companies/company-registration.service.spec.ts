import 'reflect-metadata';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { DataSource } from 'typeorm';
import {
  CompanyRegistrationService,
  validateCompany,
  type CompanyData,
} from './company-registration.service';
const data: CompanyData = {
  ruc: '20131312955',
  legalName: 'Empresa de prueba SAC',
  address: 'Av. Prueba 123, Lima',
  representativeName: 'Persona de prueba',
  relationship: 'representative',
  authorityExplanation: 'Representante inscrito; requiere comprobación independiente.',
  series: 'F001',
  declaration: true,
};
const record = {
  id: 'request',
  subject: 'applicant',
  email: 'test@example.test',
  status: 'draft',
  data,
};
function harness(): { query: jest.Mock; service: CompanyRegistrationService } {
  const query = jest.fn();
  const database = {
    query,
    transaction: (callback: (manager: { query: typeof query }) => unknown) => callback({ query }),
  };
  return { query, service: new CompanyRegistrationService(database as unknown as DataSource) };
}
it.each([
  { ...data, ruc: '20131312950' },
  { ...data, declaration: false },
  { ...data, authorityExplanation: 'Soy dueño' },
  { ...data, series: 'B001' },
])('rejects an incomplete or invalid submission', (invalid) => {
  expect(() => validateCompany(invalid)).toThrow(BadRequestException);
});
it('submits without creating or reserving any issuer, organization or membership', async () => {
  const { service, query } = harness();
  query.mockResolvedValueOnce([record]).mockResolvedValue([]);
  expect((await service.submit('applicant', 'request')).status).toBe('pending');
  expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining('AND subject=$2 FOR UPDATE'), [
    'request',
    'applicant',
  ]);
  expect(JSON.stringify(query.mock.calls)).not.toMatch(
    /INSERT INTO (issuers|organizations|organization_members)/,
  );
});
it('does not reveal or submit another user’s request', async () => {
  const { service, query } = harness();
  query.mockResolvedValueOnce([]);
  await expect(service.submit('attacker', 'request')).rejects.toBeInstanceOf(NotFoundException);
  expect(query).toHaveBeenCalledTimes(1);
});
it('does not edit a submitted request', async () => {
  const { service, query } = harness();
  query.mockResolvedValueOnce([]).mockResolvedValueOnce([{ ...record, status: 'pending' }]);
  await expect(
    service.save({ subject: 'applicant', email: record.email }, record.id, data),
  ).rejects.toBeInstanceOf(ConflictException);
  expect(query).toHaveBeenCalledTimes(2);
});
it('forbids self approval', async () => {
  const { service, query } = harness();
  query.mockResolvedValueOnce([{ ...record, status: 'pending' }]);
  await expect(
    service.decide(
      record.id,
      'applicant',
      'approve',
      'Comprobación completa',
      'Expediente verificado 123',
    ),
  ).rejects.toBeInstanceOf(ForbiddenException);
  expect(query).toHaveBeenCalledTimes(1);
});
it('never transfers an already registered RUC', async () => {
  const { service, query } = harness();
  query
    .mockResolvedValueOnce([{ ...record, status: 'pending' }])
    .mockResolvedValueOnce([{ id: 'existing-issuer' }]);
  await expect(
    service.decide(
      record.id,
      'reviewer',
      'approve',
      'Comprobación completa',
      'Expediente verificado 123',
    ),
  ).rejects.toBeInstanceOf(ConflictException);
  expect(query).toHaveBeenCalledTimes(2);
});
it('rejects without granting any membership', async () => {
  const { service, query } = harness();
  query.mockResolvedValueOnce([{ ...record, status: 'pending' }]).mockResolvedValue([]);
  expect(
    (await service.decide(record.id, 'reviewer', 'reject', 'Falta acreditar representación', ''))
      .status,
  ).toBe('rejected');
  expect(JSON.stringify(query.mock.calls)).not.toContain('INSERT INTO organization_members');
});
it('approval creates a separate organization, issuer and series with an audit event', async () => {
  const { service, query } = harness();
  query.mockResolvedValueOnce([{ ...record, status: 'pending' }]).mockResolvedValue([]);
  const approved = await service.decide(
    record.id,
    'reviewer',
    'approve',
    'Verificación independiente completada',
    'Referencia privada de evidencia',
  );
  expect(approved.status).toBe('approved');
  expect(approved.organization_id).toBeTruthy();
  expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO organization_members'), [
    expect.any(String),
    approved.organization_id,
    'applicant',
  ]);
  expect(query).toHaveBeenLastCalledWith(
    expect.stringContaining('INSERT INTO company_registration_events'),
    [record.id, 'reviewer', 'approved', expect.stringContaining('Referencia privada')],
  );
});
