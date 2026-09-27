import { Body, Controller, Get, Header, Post, Query, Req, Res } from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';
import { IsUUID } from 'class-validator';
import { PublicRoute } from './auth.decorators';
import {
  BrowserSessionService,
  cookieValue,
  LOGIN_COOKIE,
  SESSION_COOKIE,
} from './browser-session.service';
import type { SessionView } from './browser-session.service';
class SelectOrganizationDto {
  @IsUUID() organizationId!: string;
}
@Controller('auth')
@PublicRoute()
export class BrowserAuthController {
  constructor(private readonly sessions: BrowserSessionService) {}
  private cookie(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.sessions.config?.secure ?? true,
      sameSite: 'lax',
      path: '/',
    };
  }
  @Get('session')
  @Header('Cache-Control', 'no-store')
  session(@Req() request: Request): Promise<SessionView> {
    return this.sessions.view(request);
  }
  @Get('login')
  async login(@Res() response: Response): Promise<void> {
    const { url, binding } = await this.sessions.begin();
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.cookie(LOGIN_COOKIE, binding, { ...this.cookie(), maxAge: 600000 });
    response.redirect(302, url);
  }
  @Get('callback')
  async callback(
    @Query('code') code: unknown,
    @Query('state') state: unknown,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.clearCookie(LOGIN_COOKIE, this.cookie());
    const origin = this.sessions.config?.origin;
    if (!origin) {
      response.status(503).send('El acceso no está configurado.');
      return;
    }
    try {
      if (typeof code !== 'string' || typeof state !== 'string')
        throw new Error('Invalid callback');
      const result = await this.sessions.finish(code, state, cookieValue(request, LOGIN_COOKIE));
      await this.sessions.remove(request);
      response.cookie(SESSION_COOKIE, result.token, {
        ...this.cookie(),
        expires: result.expiresAt,
      });
      response.redirect(303, `${origin}/conexion?login=success`);
    } catch {
      // Never reflect codes, provider error descriptions or token-verifier errors.
      response.redirect(303, `${origin}/conexion?error=login_failed`);
    }
  }
  @Post('organization')
  @Header('Cache-Control', 'no-store')
  async select(@Body() body: SelectOrganizationDto, @Req() request: Request): Promise<SessionView> {
    await this.sessions.select(request, body.organizationId);
    return this.sessions.view(request);
  }
  @Post('logout-all')
  async logoutAll(@Req() request: Request, @Res() response: Response): Promise<void> {
    const url = await this.sessions.logout(request, true);
    response.setHeader('Cache-Control', 'no-store');
    response.clearCookie(SESSION_COOKIE, this.cookie());
    response.clearCookie(LOGIN_COOKIE, this.cookie());
    response.json({ url });
  }
  @Post('logout')
  async logout(@Req() request: Request, @Res() response: Response): Promise<void> {
    const url = await this.sessions.logout(request);
    response.setHeader('Cache-Control', 'no-store');
    response.clearCookie(SESSION_COOKIE, this.cookie());
    response.clearCookie(LOGIN_COOKIE, this.cookie());
    response.json({ url });
  }
}
