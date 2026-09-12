import { randomBytes } from 'node:crypto';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { parseEnvironment, readSecretFile } from '@app/platform';
import { ApiKeyEntity, OrganizationMemberEntity, ServiceAccountEntity } from '../database/entities';
import { ApiKeyService, API_KEY_PEPPER } from './api-key.service';
import { AuthenticationGuard } from './authentication.guard';

function loadSecret(path: string | undefined, purpose: string, expectedBytes?: number): Buffer {
  const environment = parseEnvironment(process.env);
  if (path) {
    return readSecretFile(path, expectedBytes);
  }
  if (environment.NODE_ENV === 'test' || environment.ALLOW_VOLATILE_ADAPTERS) {
    return randomBytes(expectedBytes ?? 32);
  }
  throw new Error(`${purpose} secret file is required; set its *_FILE configuration`);
}

@Module({
  imports: [
    TypeOrmModule.forFeature([ApiKeyEntity, ServiceAccountEntity, OrganizationMemberEntity]),
    JwtModule.registerAsync({
      useFactory: () => {
        const environment = parseEnvironment(process.env);
        return {
          secret: loadSecret(environment.BILLING_JWT_SECRET_FILE, 'JWT'),
          signOptions: {
            issuer: environment.BILLING_JWT_ISSUER,
            audience: environment.BILLING_JWT_AUDIENCE,
            algorithm: 'HS256' as const,
          },
          verifyOptions: {
            issuer: environment.BILLING_JWT_ISSUER,
            audience: environment.BILLING_JWT_AUDIENCE,
            algorithms: ['HS256' as const],
          },
        };
      },
    }),
  ],
  providers: [
    {
      provide: API_KEY_PEPPER,
      useFactory: () => {
        const environment = parseEnvironment(process.env);
        return loadSecret(environment.BILLING_API_KEY_PEPPER_FILE, 'API key pepper', 32);
      },
    },
    ApiKeyService,
    AuthenticationGuard,
    { provide: APP_GUARD, useExisting: AuthenticationGuard },
  ],
  exports: [API_KEY_PEPPER, ApiKeyService, JwtModule],
})
export class AuthModule {}
