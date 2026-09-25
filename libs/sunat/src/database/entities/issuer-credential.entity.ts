import type { EncryptedEnvelope } from '@app/platform';
import {
  Column,
  Check,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'issuer_credentials' })
@Index(['issuerId', 'version'], { unique: true })
@Index('uq_issuer_credentials_active', ['issuerId'], {
  unique: true,
  where: 'active = true',
})
@Check(
  'ck_issuer_credentials_certificate_sha256',
  `certificate_archive_sha256 IS NULL OR certificate_archive_sha256 ~ '^[0-9a-f]{64}$'`,
)
export class IssuerCredentialEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId!: string;

  @Column({ name: 'issuer_id', type: 'uuid' })
  issuerId!: string;

  @Column({ name: 'issuer_ruc', type: 'char', length: 11 })
  issuerRuc!: string;

  @Column({ type: 'varchar', length: 16 })
  environment!: 'beta' | 'production';

  @Column({ type: 'integer' })
  version!: number;

  @Column({ name: 'sol_envelope', type: 'jsonb' })
  solEnvelope!: EncryptedEnvelope;

  @Column({ name: 'certificate_envelope', type: 'jsonb', nullable: true })
  certificateEnvelope!: EncryptedEnvelope | null;

  @Column({
    name: 'certificate_archive_sha256',
    type: 'char',
    length: 64,
    nullable: true,
  })
  certificateArchiveSha256!: string | null;

  @Column({ name: 'certificate_expires_at', type: 'timestamptz', nullable: true })
  certificateExpiresAt!: Date | null;

  @Column({ type: 'boolean', default: true })
  active!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
