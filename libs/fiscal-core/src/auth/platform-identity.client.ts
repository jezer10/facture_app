import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { UnauthorizedException, ServiceUnavailableException } from '@nestjs/common';
import { JwtVerifier } from 'aws-jwt-verify';
import { readSecretFile } from '@app/platform';
export interface PlatformIdentityConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  key: Buffer;
}
export function platformIdentityConfig(env = process.env): PlatformIdentityConfig | null {
  const values = [
    env.BILLING_IDENTITY_ISSUER,
    env.BILLING_IDENTITY_CLIENT_ID,
    env.BILLING_IDENTITY_CLIENT_SECRET_FILE,
    env.BILLING_IDENTITY_DATA_KEY_FILE,
  ];
  if (values.every((v) => !v)) return null;
  if (values.some((v) => !v)) throw new Error('All BILLING_IDENTITY_* settings are required');
  const issuer = new URL(values[0]!);
  if (
    issuer.pathname !== '/' ||
    issuer.search ||
    issuer.hash ||
    issuer.username ||
    issuer.password ||
    (issuer.protocol !== 'https:' &&
      !(
        env.NODE_ENV !== 'production' &&
        issuer.protocol === 'http:' &&
        ['127.0.0.1', 'localhost'].includes(issuer.hostname)
      ))
  )
    throw new Error('Invalid platform identity issuer');
  const key = Buffer.from(readSecretFile(values[3]!).toString('utf8').trim(), 'base64');
  if (key.length !== 32) throw new Error('Identity data key must be 32 bytes');
  return {
    issuer: issuer.origin,
    clientId: values[1]!,
    clientSecret: readSecretFile(values[2]!).toString('utf8').trim(),
    key,
  };
}
export class PlatformIdentityClient {
  private readonly verifier;
  constructor(readonly config: PlatformIdentityConfig) {
    this.verifier = JwtVerifier.create({
      issuer: config.issuer,
      audience: config.clientId,
      jwksUri: `${config.issuer}/oidc/jwks`,
    });
  }
  seal(token: string): string {
    return this.encrypt(token, randomBytes(12));
  }

  private encrypt(token: string, iv: Buffer): string {
    const cipher = createCipheriv('aes-256-gcm', this.config.key, iv);
    const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }
  open(value: string): string {
    const data = Buffer.from(value, 'base64');
    const cipher = createDecipheriv('aes-256-gcm', this.config.key, data.subarray(0, 12));
    cipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8');
  }
  async introspect(token: string): Promise<Record<string, unknown>> {
    const r = await fetch(`${this.config.issuer}/oidc/introspection`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({ token }),
    }).catch(() => {
      throw new ServiceUnavailableException('No se pudo verificar la sesión central.');
    });
    if (!r.ok) throw new ServiceUnavailableException('No se pudo verificar la sesión central.');
    return (await r.json()) as Record<string, unknown>;
  }
  async verify(
    idToken: string,
    accessToken: string,
    nonce: string,
    poolId: string,
  ): Promise<{ subject: string; email: string; expiresAt: Date }> {
    const id = await this.verifier.verify(idToken);
    if (
      typeof id.exp !== 'number' ||
      id.nonce !== nonce ||
      !id.sub?.startsWith(`cognito:${poolId}:`)
    )
      throw new UnauthorizedException('Invalid central identity');
    const access = await this.introspect(accessToken);
    if (
      access.active !== true ||
      access.sub !== id.sub ||
      access.client_id !== this.config.clientId ||
      typeof access.exp !== 'number'
    )
      throw new UnauthorizedException('Invalid central session');
    const r = await fetch(`${this.config.issuer}/oidc/me`, {
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) throw new UnauthorizedException('Invalid central profile');
    const profile = (await r.json()) as Record<string, unknown>;
    if (
      profile.sub !== id.sub ||
      profile.email_verified !== true ||
      typeof profile.email !== 'string'
    )
      throw new UnauthorizedException('Unverified central profile');
    return {
      subject: id.sub,
      email: profile.email,
      expiresAt: new Date(Math.min(id.exp, access.exp, Math.floor(Date.now() / 1000) + 900) * 1000),
    };
  }
}
