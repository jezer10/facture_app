import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EnvelopeEncryption, parseEnvironment, readSecretFile } from '@app/platform';
import { AuthModule } from '../auth/auth.module';
import { API_KEY_PEPPER } from '../auth/api-key.service';
import {
  ApiKeyCreationRequestEntity,
  ApiKeyEntity,
  AuditLogEntity,
  IssuerEntity,
  IssuerSeriesEntity,
  OrganizationEntity,
  OrganizationMemberEntity,
  ServiceAccountEntity,
  ServiceAccountIssuerGrantEntity,
} from '../database/entities';
import {
  API_KEY_REPLAY_ENCRYPTION,
  API_KEY_REPLAY_TTL_SECONDS,
  ApiKeyReplayService,
} from './api-key-replay.service';
import { AdministrationService } from './administration.service';

@Module({
  imports: [
    AuthModule,
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([
      OrganizationEntity,
      OrganizationMemberEntity,
      ServiceAccountEntity,
      ApiKeyEntity,
      ApiKeyCreationRequestEntity,
      IssuerEntity,
      IssuerSeriesEntity,
      ServiceAccountIssuerGrantEntity,
      AuditLogEntity,
    ]),
  ],
  providers: [
    {
      provide: API_KEY_REPLAY_ENCRYPTION,
      useFactory: createApiKeyReplayEncryption,
      inject: [API_KEY_PEPPER],
    },
    {
      provide: API_KEY_REPLAY_TTL_SECONDS,
      useFactory: () => parseEnvironment(process.env).BILLING_API_KEY_REPLAY_TTL_SECONDS,
    },
    ApiKeyReplayService,
    AdministrationService,
  ],
  exports: [AdministrationService],
})
export class AdministrationModule {}

function createApiKeyReplayEncryption(apiKeyPepper: Buffer): EnvelopeEncryption {
  const environment = parseEnvironment(process.env);
  const path = environment.BILLING_API_KEY_REPLAY_KEY_FILE;
  if (!path) {
    if (environment.NODE_ENV === 'test' || environment.ALLOW_VOLATILE_ADAPTERS) {
      return new EnvelopeEncryption(randomBytes(32));
    }
    throw new Error(
      'API-key replay encryption secret file is required; set BILLING_API_KEY_REPLAY_KEY_FILE',
    );
  }
  const loadedKey = readSecretFile(path, 32);
  try {
    if (loadedKey.length === apiKeyPepper.length && timingSafeEqual(loadedKey, apiKeyPepper)) {
      throw new Error('API-key replay encryption key must differ from the API key pepper');
    }
    return new EnvelopeEncryption(Buffer.from(loadedKey));
  } finally {
    loadedKey.fill(0);
  }
}
