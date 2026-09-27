import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { Request } from 'express';
import { PlatformIdentityClient, platformIdentityConfig } from './platform-identity.client';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { browserAuthConfig } from './browser-auth.config';
import type { BrowserAuthConfig } from './browser-auth.config';
import type { HumanPrincipal, OrganizationRole } from './auth.types';

export const SESSION_COOKIE = 'facture_session';
export const LOGIN_COOKIE = 'facture_login';
interface LoginAttempt {
  verifier: string;
  nonce: string;
}
interface BrowserSession {
  token_hash: string;
  subject: string;
  email: string;
  csrf_token: string;
  organization_id: string | null;
  expires_at: Date;
}
interface OrganizationAccess {
  environment: 'sandbox' | 'production';
  companyId: string | null;
  verified: boolean;
  id: string;
  name: string;
  role: OrganizationRole;
}
export interface SessionView {
  readonly loginMode?: 'native' | 'central';
  readonly enabled: boolean;
  readonly authenticated: boolean;
  readonly email?: string;
  readonly csrfToken?: string;
  readonly organizations?: readonly OrganizationAccess[];
  readonly organizationId?: string | null;
  readonly expiresAt?: string;
}
function random(): string {
  return randomBytes(32).toString('base64url');
}
export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export function cookieValue(request: Request, name: string): string {
  const entries = (request.get('cookie') ?? '')
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith(`${name}=`));
  if (entries.length !== 1) return '';
  const value = entries[0]!.slice(name.length + 1);
  return /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : '';
}
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

@Injectable()
export class BrowserSessionService {
  readonly config = browserAuthConfig();
  readonly platformConfig = platformIdentityConfig();
  private readonly platform = this.platformConfig
    ? new PlatformIdentityClient(this.platformConfig)
    : null;
  private readonly idVerifier =
    this.config && !this.platform
      ? CognitoJwtVerifier.create({
          userPoolId: this.config.poolId,
          clientId: this.config.clientId,
          tokenUse: 'id',
        })
      : null;
  private readonly accessVerifier =
    this.config && !this.platform
      ? CognitoJwtVerifier.create({
          userPoolId: this.config.poolId,
          clientId: this.config.clientId,
          tokenUse: 'access',
        })
      : null;
  constructor(private readonly database: DataSource) {}

  private configured(): BrowserAuthConfig {
    if (!this.config)
      throw new ServiceUnavailableException('El inicio de sesión aún no está configurado.');
    return this.config;
  }
  async begin(): Promise<{ url: string; binding: string }> {
    const config = this.configured();
    const state = random();
    const binding = random();
    const verifier = random();
    const nonce = random();
    await this.database.query('DELETE FROM browser_login_attempts WHERE expires_at <= now()');
    await this.database.query('DELETE FROM browser_sessions WHERE expires_at <= now()');
    await this.database.query(
      "INSERT INTO browser_login_attempts(state_hash,binding_hash,verifier,nonce,expires_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes')",
      [digest(state), digest(binding), verifier, nonce],
    );
    const url = new URL(
      this.platform ? '/oidc/auth' : '/oauth2/authorize',
      this.platformConfig?.issuer ?? config.domain,
    );
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.platformConfig?.clientId ?? config.clientId,
      redirect_uri: `${config.origin}/api/v1/auth/callback`,
      scope: 'openid email',
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    }).toString();
    return { url: url.toString(), binding };
  }

  async finish(
    code: string,
    state: string,
    binding: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const config = this.configured();
    if (
      !/^[A-Za-z0-9_-]{43}$/u.test(state) ||
      !/^[A-Za-z0-9_-]{43}$/u.test(binding) ||
      !code ||
      code.length > 4096
    )
      throw new UnauthorizedException('Invalid login callback');
    // Atomic consumption rejects replay, including concurrent callbacks.
    // SELECT keeps TypeORM results as rows; bare DELETE RETURNING yields [rows, count].
    const [attempt] = await this.database.query<LoginAttempt[]>(
      'WITH consumed AS (DELETE FROM browser_login_attempts WHERE state_hash=$1 AND binding_hash=$2 AND expires_at>now() RETURNING verifier,nonce) SELECT verifier,nonce FROM consumed',
      [digest(state), digest(binding)],
    );
    if (!attempt) throw new UnauthorizedException('Login attempt expired or already used');
    const response = await fetch(
      new URL(
        this.platform ? '/oidc/token' : '/oauth2/token',
        this.platformConfig?.issuer ?? config.domain,
      ),
      {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${Buffer.from(`${this.platformConfig?.clientId ?? config.clientId}:${this.platformConfig?.clientSecret ?? config.clientSecret}`).toString('base64')}`,
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: this.platformConfig?.clientId ?? config.clientId,
          code,
          redirect_uri: `${config.origin}/api/v1/auth/callback`,
          code_verifier: attempt.verifier,
        }),
      },
    );
    if (!response.ok) throw new UnauthorizedException('Identity provider rejected the login');
    const tokens: unknown = await response.json();
    if (
      !tokens ||
      typeof tokens !== 'object' ||
      !('id_token' in tokens) ||
      !('access_token' in tokens) ||
      typeof tokens.id_token !== 'string' ||
      typeof tokens.access_token !== 'string'
    )
      throw new UnauthorizedException('Invalid identity response');
    if (this.platform) {
      const identity = await this.platform.verify(
        tokens.id_token,
        tokens.access_token,
        attempt.nonce,
        config.poolId,
      );
      return this.createSession(
        identity.subject,
        identity.email,
        identity.expiresAt,
        tokens.access_token,
      );
    }
    return this.fromIdentityTokens(tokens.id_token, tokens.access_token, attempt.nonce);
  }

  // Only server-side Cognito exchanges call this; it is never exposed as a token-login endpoint.
  async fromIdentityTokens(
    idToken: string,
    accessToken: string,
    nonce?: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    const config = this.configured();
    if (this.platform) throw new UnauthorizedException('Usa el acceso central.');
    const [id, access] = await Promise.all([
      this.idVerifier!.verify(idToken),
      this.accessVerifier!.verify(accessToken),
    ]);
    if (
      (nonce !== undefined && id.nonce !== nonce) ||
      id.sub !== access.sub ||
      id.email_verified !== true ||
      typeof id.email !== 'string'
    )
      throw new UnauthorizedException('Identity could not be verified');
    const expiresAt = new Date(
      Math.min(id.exp, access.exp, Math.floor(Date.now() / 1000) + 900) * 1000,
    );
    if (expiresAt.getTime() <= Date.now()) throw new UnauthorizedException('Identity expired');
    const subject = `cognito:${config.poolId}:${id.sub}`;
    return this.createSession(subject, id.email, expiresAt);
  }

  private async createSession(
    subject: string,
    email: string,
    expiresAt: Date,
    accessToken?: string,
  ): Promise<{ token: string; expiresAt: Date }> {
    await this.activateInvitations(subject, email);
    const organizations = await this.organizations(subject);
    const token = random();
    await this.database.query(
      'INSERT INTO browser_sessions(token_hash,subject,email,csrf_token,organization_id,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
      [
        digest(token),
        subject,
        email,
        random(),
        organizations.length === 1 ? organizations[0]!.id : null,
        expiresAt,
      ],
    );
    if (this.platform && accessToken) {
      try {
        await this.database.query(
          'INSERT INTO browser_identity_tokens(token_hash, encrypted_access_token) VALUES($1,$2)',
          [digest(token), this.platform.seal(accessToken)],
        );
      } catch (error) {
        await this.database.query('DELETE FROM browser_sessions WHERE token_hash=$1', [
          digest(token),
        ]);
        throw error;
      }
    }
    // Central access tokens are encrypted server-side, never exposed to Vue.
    return { token, expiresAt };
  }

  private async activateInvitations(subject: string, email: string): Promise<void> {
    await this.database.transaction(async (manager) => {
      const invitations = await manager.query<
        { organization_id: string; role: OrganizationRole }[]
      >(
        'WITH claimed AS (UPDATE browser_access_invites SET claimed_subject=$1 WHERE email=$2 AND claimed_subject IS NULL AND expires_at>now() RETURNING organization_id,role) SELECT organization_id,role FROM claimed',
        [subject, email.trim().toLowerCase()],
      );
      for (const invitation of invitations) {
        await manager.query(
          'INSERT INTO organization_members(id,organization_id,subject,role) VALUES($1,$2,$3,$4) ON CONFLICT(organization_id,subject) DO NOTHING',
          [randomUUID(), invitation.organization_id, subject, invitation.role],
        );
      }
    });
  }

  private organizations(subject: string): Promise<OrganizationAccess[]> {
    return this.database.query<OrganizationAccess[]>(
      'SELECT o.id,o.name,m.role,o.environment,o.company_id AS "companyId",(o.verified_at IS NOT NULL) AS verified FROM organizations o JOIN organization_members m ON m.organization_id=o.id WHERE m.subject=$1 ORDER BY o.name,o.id',
      [subject],
    );
  }
  private async find(request: Request, checkCentral = true): Promise<BrowserSession | null> {
    if (!this.config) return null;
    const token = cookieValue(request, SESSION_COOKIE);
    if (!token) return null;
    const [session] = await this.database.query<BrowserSession[]>(
      'SELECT token_hash,subject,email,csrf_token,organization_id,expires_at FROM browser_sessions WHERE token_hash=$1 AND expires_at>now()',
      [digest(token)],
    );
    if (session && this.platform && checkCentral) {
      const [stored] = await this.database.query<{ encrypted_access_token: string }[]>(
        'SELECT encrypted_access_token FROM browser_identity_tokens WHERE token_hash=$1',
        [session.token_hash],
      );
      if (!stored) return null;
      const access = await this.platform.introspect(
        this.platform.open(stored.encrypted_access_token),
      );
      if (
        access.active !== true ||
        access.sub !== session.subject ||
        access.client_id !== this.platformConfig!.clientId
      ) {
        await this.database.query('DELETE FROM browser_sessions WHERE token_hash=$1', [
          session.token_hash,
        ]);
        return null;
      }
    }
    return session?.subject.startsWith(`cognito:${this.config.poolId}:`) ? session : null;
  }
  assertOrigin(request: Request): void {
    if (request.get('origin') !== this.configured().origin)
      throw new ForbiddenException('Request origin is not allowed');
  }
  private csrf(request: Request, session: BrowserSession): void {
    this.assertOrigin(request);
    if (!equal(request.get('x-csrf-token') ?? '', session.csrf_token))
      throw new ForbiddenException('Invalid session request');
  }
  async view(request: Request): Promise<SessionView> {
    const session = await this.find(request);
    if (!session)
      return {
        enabled: Boolean(this.config),
        authenticated: false,
        ...(this.platform ? { loginMode: 'central' as const } : {}),
      };
    const organizations = await this.organizations(session.subject);
    const organizationId = organizations.some((org) => org.id === session.organization_id)
      ? session.organization_id
      : null;
    return {
      enabled: true,
      ...(this.platform ? { loginMode: 'central' as const } : {}),
      authenticated: true,
      email: session.email,
      csrfToken: session.csrf_token,
      organizations,
      organizationId,
      expiresAt: new Date(session.expires_at).toISOString(),
    };
  }
  async select(request: Request, organizationId: string): Promise<void> {
    const session = await this.find(request);
    if (!session) throw new UnauthorizedException();
    this.csrf(request, session);
    const organizations = await this.organizations(session.subject);
    if (!organizations.some((org) => org.id === organizationId))
      throw new ForbiddenException('No tienes acceso a esta organización.');
    await this.database.query(
      'UPDATE browser_sessions SET organization_id=$1 WHERE token_hash=$2',
      [organizationId, session.token_hash],
    );
  }
  async identity(request: Request): Promise<{ subject: string; email: string }> {
    const session = await this.find(request);
    if (!session) throw new UnauthorizedException('Inicia sesión para continuar.');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) this.csrf(request, session);
    return { subject: session.subject, email: session.email };
  }
  async principal(request: Request): Promise<HumanPrincipal> {
    const session = await this.find(request);
    if (!session) throw new UnauthorizedException('Inicia sesión para continuar.');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) this.csrf(request, session);
    const organizations = await this.organizations(session.subject);
    const selected = organizations.find((org) => org.id === session.organization_id);
    if (!selected)
      throw new ForbiddenException('Selecciona una organización a la que tengas acceso.');
    return {
      kind: 'human',
      subject: session.subject,
      organizationId: selected.id,
      role: selected.role,
      platformAdmin: false,
    };
  }
  async logout(request: Request, global = false): Promise<string> {
    const config = this.configured();
    this.assertOrigin(request);
    const session = await this.find(request, false);
    if (session) this.csrf(request, session);
    await this.remove(request);
    if (this.platform) {
      if (!global) return `${config.origin}/conexion`;
      const central = new URL('/oidc/session/end', this.platformConfig!.issuer);
      central.search = new URLSearchParams({
        client_id: this.platformConfig!.clientId,
        post_logout_redirect_uri: `${config.origin}/conexion`,
      }).toString();
      return central.toString();
    }
    const url = new URL('/logout', config.domain);
    url.search = new URLSearchParams({
      client_id: this.platformConfig?.clientId ?? config.clientId,
      logout_uri: `${config.origin}/conexion`,
    }).toString();
    return url.toString();
  }
  async invalidateEmailSessions(email: string): Promise<void> {
    await this.database.query(
      'DELETE FROM browser_sessions WHERE lower(email)=$1 AND subject LIKE $2',
      [email.toLowerCase(), `cognito:${this.configured().poolId}:%`],
    );
  }
  async remove(request: Request): Promise<void> {
    const token = cookieValue(request, SESSION_COOKIE);
    if (token)
      await this.database.query('DELETE FROM browser_sessions WHERE token_hash=$1', [
        digest(token),
      ]);
  }
}
