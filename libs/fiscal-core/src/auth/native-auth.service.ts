import { createHmac, randomBytes } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  SignUpCommand,
  ConfirmSignUpCommand,
  ResendConfirmationCodeCommand,
  ForgotPasswordCommand,
  ConfirmForgotPasswordCommand,
  type InitiateAuthCommandOutput,
  type ChallengeNameType,
} from '@aws-sdk/client-cognito-identity-provider';
import { BrowserSessionService, digest } from './browser-session.service';
export const CHALLENGE_COOKIE = 'facture_challenge';
export interface NativeResult {
  step: 'authenticated' | 'confirm' | 'login' | 'reset' | 'challenge' | 'hosted';
  message?: string;
  challenge?: string;
  token?: string;
  expiresAt?: Date;
  binding?: string;
}
@Injectable()
export class NativeAuthService {
  private readonly client: CognitoIdentityProviderClient;
  constructor(
    private readonly sessions: BrowserSessionService,
    private readonly database: DataSource,
  ) {
    this.client = new CognitoIdentityProviderClient({
      region: sessions.config?.poolId.split('_')[0] ?? 'us-east-1',
      maxAttempts: 1,
      requestHandler: { connectionTimeout: 3000, requestTimeout: 10000 },
    });
  }
  private configured(): NonNullable<BrowserSessionService['config']> {
    if (this.sessions.platformConfig)
      throw new ServiceUnavailableException('Usa el acceso central para iniciar sesión.');
    if (!this.sessions.config)
      throw new ServiceUnavailableException('El acceso aún no está configurado.');
    return this.sessions.config;
  }
  private hash(username: string): string {
    const config = this.configured();
    return createHmac('sha256', config.clientSecret)
      .update(username + config.clientId)
      .digest('base64');
  }
  private input(email: string): { ClientId: string; Username: string; SecretHash: string } {
    const username = email.trim().toLowerCase();
    return {
      ClientId: this.configured().clientId,
      Username: username,
      SecretHash: this.hash(username),
    };
  }
  private failure(error: unknown): never {
    const name = error instanceof Error ? error.name : '';
    if (['CodeMismatchException', 'ExpiredCodeException'].includes(name))
      throw new BadRequestException('El código no es válido o venció. Solicita uno nuevo.');
    if (name === 'InvalidPasswordException')
      throw new BadRequestException(
        'Usa al menos 12 caracteres con mayúsculas, minúsculas, números y símbolos.',
      );
    if (['TooManyRequestsException', 'LimitExceededException'].includes(name))
      throw new BadRequestException('Espera unos minutos antes de volver a intentarlo.');
    if (['NotAuthorizedException', 'UserNotFoundException'].includes(name))
      throw new UnauthorizedException('No pudimos iniciar sesión. Revisa tu correo y contraseña.');
    throw new ServiceUnavailableException('No pudimos completar la operación. Inténtalo de nuevo.');
  }
  async login(email: string, password: string): Promise<NativeResult> {
    const input = this.input(email);
    try {
      const output = await this.client.send(
        new InitiateAuthCommand({
          ClientId: input.ClientId,
          AuthFlow: 'USER_PASSWORD_AUTH',
          AuthParameters: {
            USERNAME: input.Username,
            PASSWORD: password,
            SECRET_HASH: input.SecretHash,
          },
        }),
      );
      return await this.complete(output, input.Username);
    } catch (error) {
      if (error instanceof Error && error.name === 'UserNotConfirmedException')
        return {
          step: 'confirm',
          message: 'Verifica tu correo para continuar. Puedes solicitar otro código.',
        };
      if (error instanceof Error && error.name === 'PasswordResetRequiredException')
        return {
          step: 'reset',
          message: 'Debes recuperar tu contraseña. Solicita un código para continuar.',
        };
      this.failure(error);
    }
  }
  private async complete(
    output: InitiateAuthCommandOutput,
    username: string,
  ): Promise<NativeResult> {
    const tokens = output.AuthenticationResult;
    if (tokens?.IdToken && tokens.AccessToken) {
      const session = await this.sessions.fromIdentityTokens(tokens.IdToken, tokens.AccessToken);
      return { step: 'authenticated', ...session };
    }
    const supported = ['SMS_MFA', 'SOFTWARE_TOKEN_MFA', 'EMAIL_OTP', 'NEW_PASSWORD_REQUIRED'];
    if (!output.Session || !output.ChallengeName || !supported.includes(output.ChallengeName))
      return {
        step: 'hosted',
        message: 'Tu cuenta necesita un paso adicional. Continúa por el acceso seguro.',
      };
    // Required custom attributes and MFA enrollment remain in Cognito managed login.
    if (
      output.ChallengeName === 'NEW_PASSWORD_REQUIRED' &&
      output.ChallengeParameters?.requiredAttributes &&
      output.ChallengeParameters.requiredAttributes !== '[]'
    )
      return { step: 'hosted' };
    const binding = randomBytes(32).toString('base64url');
    await this.database.query('DELETE FROM browser_auth_challenges WHERE expires_at<=now()');
    await this.database.query(
      "INSERT INTO browser_auth_challenges(token_hash,username,challenge,provider_session,expires_at) VALUES($1,$2,$3,$4,now()+interval '3 minutes')",
      [
        digest(binding),
        output.ChallengeParameters?.USER_ID_FOR_SRP ??
          output.ChallengeParameters?.USERNAME ??
          username,
        output.ChallengeName,
        output.Session,
      ],
    );
    return { step: 'challenge', challenge: output.ChallengeName, binding };
  }
  async challenge(binding: string, code?: string, password?: string): Promise<NativeResult> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(binding))
      throw new UnauthorizedException('Vuelve a iniciar sesión.');
    const [attempt] = await this.database.query<
      { username: string; challenge: ChallengeNameType; provider_session: string }[]
    >(
      'WITH consumed AS (DELETE FROM browser_auth_challenges WHERE token_hash=$1 AND expires_at>now() RETURNING *) SELECT * FROM consumed',
      [digest(binding)],
    );
    if (!attempt) throw new UnauthorizedException('El intento venció. Vuelve a iniciar sesión.');
    const field = (
      {
        SMS_MFA: 'SMS_MFA_CODE',
        SOFTWARE_TOKEN_MFA: 'SOFTWARE_TOKEN_MFA_CODE',
        EMAIL_OTP: 'EMAIL_OTP_CODE',
        NEW_PASSWORD_REQUIRED: 'NEW_PASSWORD',
      } as Record<string, string>
    )[attempt.challenge];
    const value = attempt.challenge === 'NEW_PASSWORD_REQUIRED' ? password : code;
    if (!field || !value)
      throw new BadRequestException(
        'Completa el código o la nueva contraseña y vuelve a iniciar sesión.',
      );
    try {
      const output = await this.client.send(
        new RespondToAuthChallengeCommand({
          ClientId: this.configured().clientId,
          ChallengeName: attempt.challenge,
          Session: attempt.provider_session,
          ChallengeResponses: {
            USERNAME: attempt.username,
            SECRET_HASH: this.hash(attempt.username),
            [field]: value,
          },
        }),
      );
      return await this.complete(output, attempt.username);
    } catch {
      throw new UnauthorizedException(
        'No pudimos verificar el paso adicional. Vuelve a iniciar sesión.',
      );
    }
  }
  async register(email: string, password: string): Promise<NativeResult> {
    try {
      await this.client.send(
        new SignUpCommand({
          ...this.input(email),
          Password: password,
          UserAttributes: [{ Name: 'email', Value: email.trim().toLowerCase() }],
        }),
      );
    } catch (error) {
      if (!(error instanceof Error && error.name === 'UsernameExistsException'))
        this.failure(error);
    }
    return {
      step: 'confirm',
      message:
        'Si tu cuenta necesita verificación, revisa tu correo. Si ya tienes una cuenta, puedes iniciar sesión.',
    };
  }
  async confirm(email: string, code: string): Promise<NativeResult> {
    try {
      await this.client.send(
        new ConfirmSignUpCommand({ ...this.input(email), ConfirmationCode: code }),
      );
      return { step: 'login', message: 'Correo verificado. Ya puedes iniciar sesión.' };
    } catch (error) {
      this.failure(error);
    }
  }
  async resend(email: string): Promise<NativeResult> {
    try {
      await this.client.send(new ResendConfirmationCodeCommand(this.input(email)));
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          ['UserNotFoundException', 'InvalidParameterException', 'NotAuthorizedException'].includes(
            error.name,
          )
        )
      )
        this.failure(error);
    }
    return {
      step: 'confirm',
      message:
        'Si la cuenta está pendiente, recibirás un nuevo código. Revisa también el correo no deseado.',
    };
  }
  async forgot(email: string): Promise<NativeResult> {
    try {
      await this.client.send(new ForgotPasswordCommand(this.input(email)));
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          ['UserNotFoundException', 'InvalidParameterException', 'NotAuthorizedException'].includes(
            error.name,
          )
        )
      )
        this.failure(error);
    }
    return {
      step: 'reset',
      message:
        'Si el correo tiene una cuenta recuperable, recibirás un código para cambiar tu contraseña.',
    };
  }
  async reset(email: string, code: string, password: string): Promise<NativeResult> {
    try {
      await this.client.send(
        new ConfirmForgotPasswordCommand({
          ...this.input(email),
          ConfirmationCode: code,
          Password: password,
        }),
      );
      await this.sessions.invalidateEmailSessions(email);
      return { step: 'login', message: 'Contraseña actualizada. Inicia sesión de nuevo.' };
    } catch (error) {
      this.failure(error);
    }
  }
}
