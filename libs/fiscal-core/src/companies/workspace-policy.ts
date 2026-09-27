import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { OrganizationEntity } from '../database/entities';

export async function requireWorkspace(
  manager: EntityManager,
  organizationId: string,
): Promise<OrganizationEntity> {
  const workspace = await manager
    .getRepository(OrganizationEntity)
    .findOneBy({ id: organizationId });
  if (!workspace) throw new ForbiddenException('El ambiente seleccionado no está disponible.');
  return workspace;
}

export async function requireIssuingWorkspace(
  manager: EntityManager,
  organizationId: string,
): Promise<OrganizationEntity> {
  const workspace = await requireWorkspace(manager, organizationId);
  if (workspace.environment === 'production') {
    if (!workspace.verifiedAt) throw new ForbiddenException('La empresa todavía no está validada.');
    // The direct adapter reports ready=false. Never treat stored credentials as a successful
    // connection or allow a production document to reach the beta transport.
    throw new ServiceUnavailableException(
      'La conexión productiva de SUNAT todavía no está habilitada en Facture. Puedes seguir usando Sandbox.',
    );
  }
  return workspace;
}
