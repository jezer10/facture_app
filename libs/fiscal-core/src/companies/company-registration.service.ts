import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { isValidPeruvianRuc } from '../administration/administration.service';

export interface CompanyData {
  ruc: string;
  legalName: string;
  address: string;
  representativeName: string;
  relationship: string;
  authorityExplanation: string;
  series: string;
  declaration: boolean;
}
export interface Registration {
  id: string;
  subject: string;
  email: string;
  status: 'draft' | 'pending' | 'approved' | 'rejected';
  data: Partial<CompanyData>;
  sandbox_organization_id: string | null;
  sandbox_issuer_id: string | null;
  organization_id: string | null;
  issuer_id: string | null;
  decision_note: string | null;
}
export function validateCompany(data: Partial<CompanyData>): void {
  if (!data.ruc || !isValidPeruvianRuc(data.ruc))
    throw new BadRequestException(
      'Revisa el RUC: debe tener 11 dígitos y un dígito de control válido.',
    );
  for (const key of ['legalName', 'address', 'representativeName'] as const) {
    if (!data[key] || data[key].trim().length < 3)
      throw new BadRequestException('Completa los datos de la empresa y del representante.');
  }
  if (!['owner', 'representative', 'authorized'].includes(data.relationship ?? ''))
    throw new BadRequestException('Indica tu relación con la empresa.');
  if (!data.authorityExplanation || data.authorityExplanation.trim().length < 20)
    throw new BadRequestException(
      'Explica cómo podemos comprobar tu autorización (al menos 20 caracteres).',
    );
  if (!/^F[A-Z0-9]{3}$/.test(data.series ?? ''))
    throw new BadRequestException('La serie de factura debe comenzar con F y tener 4 caracteres.');
  if (data.declaration !== true)
    throw new BadRequestException('Confirma la declaración antes de enviar.');
}
@Injectable()
export class CompanyRegistrationService {
  constructor(private readonly database: DataSource) {}

  async list(subject: string): Promise<Registration[]> {
    // Backfill legacy requests without converting their existing documents to production.
    const records = await this.database.query<Registration[]>(
      'SELECT * FROM company_registrations WHERE subject=$1 ORDER BY created_at DESC LIMIT 100',
      [subject],
    );
    for (const record of records) {
      if (record.status === 'draft') continue;
      await this.database.transaction(async (manager) => {
        const locked = await this.lock(manager, record.id, subject);
        await this.ensureSandbox(manager, locked);
        if (locked.status === 'approved' && !locked.organization_id) {
          const production = await this.createWorkspace(manager, locked, 'production');
          await manager.query(
            'UPDATE company_registrations SET organization_id=$2,issuer_id=$3 WHERE id=$1',
            [locked.id, production.organizationId, production.issuerId],
          );
          locked.organization_id = production.organizationId;
          locked.issuer_id = production.issuerId;
        }
        Object.assign(record, locked);
      });
    }
    return records;
  }
  async save(
    identity: { subject: string; email: string },
    id: string,
    data: Partial<CompanyData>,
  ): Promise<Registration> {
    return this.database.transaction(async (manager) => {
      // A client-generated UUID makes retrying creation safe. Only the owner can update a draft.
      await manager.query(
        'INSERT INTO company_registrations(id,subject,email) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',
        [id, identity.subject, identity.email],
      );
      const record = await this.lock(manager, id, identity.subject);
      if (record.status !== 'draft')
        throw new ConflictException(
          'Solo puedes editar un borrador. Crea una nueva solicitud si necesitas corregir los datos.',
        );
      const [saved] = await manager.query<Registration[]>(
        'WITH saved AS (UPDATE company_registrations SET data=$2,updated_at=now() WHERE id=$1 RETURNING *) SELECT * FROM saved',
        [id, JSON.stringify(data)],
      );
      return saved!;
    });
  }
  async submit(subject: string, id: string): Promise<Registration> {
    return this.database.transaction(async (manager) => {
      const record = await this.lock(manager, id, subject);
      if (record.status === 'pending') {
        await this.ensureSandbox(manager, record);
        return record;
      }
      if (record.status !== 'draft') throw new ConflictException('Esta solicitud ya fue revisada.');
      validateCompany(record.data);
      await this.ensureSandbox(manager, record);
      await manager.query(
        "UPDATE company_registrations SET status='pending',updated_at=now() WHERE id=$1",
        [id],
      );
      await this.event(manager, id, subject, 'submitted');
      return { ...record, status: 'pending' };
    });
  }
  reviewQueue(): Promise<Registration[]> {
    return this.database.query(
      "SELECT * FROM company_registrations WHERE status='pending' ORDER BY created_at LIMIT 100",
    );
  }
  async decide(
    id: string,
    reviewer: string,
    decision: 'approve' | 'reject',
    note: string,
    evidenceReference: string,
  ): Promise<Registration> {
    try {
      return await this.database.transaction(async (manager) => {
        const record = await this.lock(manager, id);
        if (record.subject === reviewer)
          throw new ForbiddenException('No puedes revisar tu propia solicitud.');
        if (record.status !== 'pending')
          throw new ConflictException('La solicitud ya no está pendiente.');
        if (decision === 'reject') {
          await manager.query(
            "UPDATE company_registrations SET status='rejected',decision_note=$2,updated_at=now() WHERE id=$1",
            [id, note],
          );
          await this.event(manager, id, reviewer, 'rejected', note);
          return { ...record, status: 'rejected', decision_note: note };
        }
        validateCompany(record.data);
        if (evidenceReference.trim().length < 10)
          throw new BadRequestException('Registra la referencia de la evidencia verificada.');
        const data = record.data as CompanyData;
        const existing = await manager.query<unknown[]>(
          "SELECT id FROM issuers WHERE ruc=$1 AND environment='production'",
          [data.ruc],
        );
        if (existing.length)
          throw new ConflictException(
            'El RUC ya está registrado. Resuelve el acceso con su administrador; esta solicitud no transfiere la empresa.',
          );
        const { organizationId: orgId, issuerId } = await this.createWorkspace(
          manager,
          record,
          'production',
        );
        await manager.query(
          "UPDATE company_registrations SET status='approved',organization_id=$2,issuer_id=$3,decision_note=$4,updated_at=now() WHERE id=$1",
          [id, orgId, issuerId, note],
        );
        await this.event(
          manager,
          id,
          reviewer,
          'approved',
          `${note}\nEvidencia: ${evidenceReference}`,
        );
        return {
          ...record,
          status: 'approved',
          organization_id: orgId,
          issuer_id: issuerId,
          decision_note: note,
        };
      });
    } catch (error) {
      if ((error as { driverError?: { code?: string } })?.driverError?.code === '23505')
        throw new ConflictException(
          'El RUC ya tiene un registro aprobado. Revisa el acceso existente.',
        );
      throw error;
    }
  }
  private async ensureSandbox(manager: EntityManager, record: Registration): Promise<void> {
    if (record.sandbox_organization_id) return;
    const workspace = await this.createWorkspace(manager, record, 'sandbox');
    await manager.query(
      'UPDATE company_registrations SET sandbox_organization_id=$2,sandbox_issuer_id=$3 WHERE id=$1',
      [record.id, workspace.organizationId, workspace.issuerId],
    );
    record.sandbox_organization_id = workspace.organizationId;
    record.sandbox_issuer_id = workspace.issuerId;
  }
  private async createWorkspace(
    manager: EntityManager,
    record: Registration,
    environment: 'sandbox' | 'production',
  ): Promise<{ organizationId: string; issuerId: string }> {
    const data = record.data as CompanyData;
    const organizationId = randomUUID(),
      issuerId = randomUUID();
    await manager.query(
      `INSERT INTO organizations(id,name,slug,environment,company_id,verified_at)
       VALUES($1,$2,$3,$4,$5,CASE WHEN $4::varchar='production' THEN now() ELSE NULL END)`,
      [
        organizationId,
        data.legalName.slice(0, 160),
        `empresa-${organizationId}`,
        environment,
        record.id,
      ],
    );
    await manager.query(
      "INSERT INTO organization_members(id,organization_id,subject,role) VALUES($1,$2,$3,'owner')",
      [randomUUID(), organizationId, record.subject],
    );
    await manager.query(
      'INSERT INTO issuers(id,organization_id,ruc,legal_name,address,active) VALUES($1,$2,$3,$4,$5,true)',
      [issuerId, organizationId, data.ruc, data.legalName, JSON.stringify({ line: data.address })],
    );
    for (const [type, series] of [
      ['01', data.series],
      ['03', 'B001'],
      ['07', 'FC01'],
      ['07', 'BC01'],
      ['08', 'FD01'],
      ['08', 'BD01'],
    ]) {
      await manager.query(
        'INSERT INTO issuer_series(id,issuer_id,document_type,series,next_number,active) VALUES($1,$2,$3,$4,1,true)',
        [randomUUID(), issuerId, type, series],
      );
    }
    // This address comes from the authenticated, email-verified identity, never from form data.
    await manager.query(
      'INSERT INTO verified_email_recipients(organization_id,email) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [organizationId, record.email.trim().toLowerCase()],
    );
    return { organizationId, issuerId };
  }
  private async lock(manager: EntityManager, id: string, subject?: string): Promise<Registration> {
    const [record] = await manager.query<Registration[]>(
      `SELECT * FROM company_registrations WHERE id=$1${subject ? ' AND subject=$2' : ''} FOR UPDATE`,
      subject ? [id, subject] : [id],
    );
    if (!record) throw new NotFoundException('No encontramos esta solicitud.');
    return record;
  }
  private async event(
    manager: EntityManager,
    id: string,
    actor: string,
    action: string,
    note: string | null = null,
  ): Promise<void> {
    await manager.query(
      'INSERT INTO company_registration_events(registration_id,actor,action,note) VALUES($1,$2,$3,$4)',
      [id, actor, action, note],
    );
  }
}
