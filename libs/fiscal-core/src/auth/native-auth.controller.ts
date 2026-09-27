import { Body, Controller, Header, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import type { Request, Response, CookieOptions } from 'express';
import { PublicRoute } from './auth.decorators';
import { BrowserSessionService, cookieValue, SESSION_COOKIE } from './browser-session.service';
import { NativeAuthService, CHALLENGE_COOKIE, type NativeResult } from './native-auth.service';
class EmailDto {
  @IsEmail() @MaxLength(254) email!: string;
}
class CredentialsDto extends EmailDto {
  @IsString() @MinLength(1) @MaxLength(256) password!: string;
}
class CodeDto extends EmailDto {
  @Matches(/^\d{6}$/) code!: string;
}
class ResetDto extends CodeDto {
  @IsString() @MinLength(12) @MaxLength(256) password!: string;
}
class ChallengeDto {
  @IsOptional() @Matches(/^\d{6}$/) code?: string;
  @IsOptional() @IsString() @MinLength(12) @MaxLength(256) password?: string;
}
@Controller('auth/native')
@PublicRoute()
@Throttle({ default: { limit: 6, ttl: 60000 } })
export class NativeAuthController {
  constructor(
    private readonly native: NativeAuthService,
    private readonly sessions: BrowserSessionService,
  ) {}
  private cookie(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.sessions.config?.secure ?? true,
      sameSite: 'lax',
      path: '/',
    };
  }
  private async respond(request: Request, response: Response, result: NativeResult): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    response.clearCookie(CHALLENGE_COOKIE, this.cookie());
    if (result.binding)
      response.cookie(CHALLENGE_COOKIE, result.binding, { ...this.cookie(), maxAge: 180000 });
    if (result.token && result.expiresAt) {
      await this.sessions.remove(request);
      response.cookie(SESSION_COOKIE, result.token, {
        ...this.cookie(),
        expires: result.expiresAt,
      });
    }
    // Explicit public response: provider tokens, session tokens and bindings never enter JSON.
    response.json({ step: result.step, message: result.message, challenge: result.challenge });
  }
  @Post('login')
  async login(
    @Body() body: CredentialsDto,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    this.sessions.assertOrigin(request);
    await this.respond(request, response, await this.native.login(body.email, body.password));
  }
  @Post('challenge')
  async challenge(
    @Body() body: ChallengeDto,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    this.sessions.assertOrigin(request);
    await this.respond(
      request,
      response,
      await this.native.challenge(cookieValue(request, CHALLENGE_COOKIE), body.code, body.password),
    );
  }
  @Post('register')
  @Header('Cache-Control', 'no-store')
  register(@Body() body: CredentialsDto, @Req() request: Request): Promise<NativeResult> {
    this.sessions.assertOrigin(request);
    return this.native.register(body.email, body.password);
  }
  @Post('confirm')
  @Header('Cache-Control', 'no-store')
  confirm(@Body() body: CodeDto, @Req() request: Request): Promise<NativeResult> {
    this.sessions.assertOrigin(request);
    return this.native.confirm(body.email, body.code);
  }
  @Post('resend')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  resend(@Body() body: EmailDto, @Req() request: Request): Promise<NativeResult> {
    this.sessions.assertOrigin(request);
    return this.native.resend(body.email);
  }
  @Post('forgot')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  forgot(@Body() body: EmailDto, @Req() request: Request): Promise<NativeResult> {
    this.sessions.assertOrigin(request);
    return this.native.forgot(body.email);
  }
  @Post('reset')
  @Header('Cache-Control', 'no-store')
  reset(@Body() body: ResetDto, @Req() request: Request): Promise<NativeResult> {
    this.sessions.assertOrigin(request);
    return this.native.reset(body.email, body.code, body.password);
  }
}
