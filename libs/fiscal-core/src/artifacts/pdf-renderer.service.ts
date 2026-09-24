import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import { renderOriginalInvoice } from './original-invoice-template';

@Injectable()
export class PdfRendererService implements OnModuleDestroy {
  private browser?: Browser;

  async healthCheck(): Promise<void> {
    const browser = await this.getBrowser();
    if (!browser.isConnected()) {
      throw new Error('Chromium is not connected');
    }
  }

  async render(snapshot: Record<string, unknown>, snapshotSha256: string): Promise<Buffer> {
    const browser = await this.getBrowser();
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.route('**/*', (route) => route.abort());
    try {
      await page.setContent(buildInvoiceHtml(snapshot, '', snapshotSha256), {
        waitUntil: 'domcontentloaded',
      });
      return await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '0', right: '0', bottom: '0', left: '0' },
      });
    } finally {
      await context.close();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.browser?.close();
  }

  private async getBrowser(): Promise<Browser> {
    // The renderer only loads escaped, size-bounded fiscal data: JavaScript is disabled and
    // every network request is aborted. Docker's default seccomp profile remains enabled,
    // while Chromium's nested user-namespace sandbox is unavailable in a standard container.
    this.browser ??= await chromium.launch({ headless: true, chromiumSandbox: false });
    return this.browser;
  }
}

export function buildQrPayload(snapshot: Record<string, unknown>, snapshotSha256: string): string {
  const issuer = record(snapshot.issuer);
  const customer = record(snapshot.customer);
  const totals = record(snapshot.totals);
  return [
    stringValue(issuer.ruc),
    stringValue(snapshot.documentType),
    stringValue(snapshot.series),
    stringValue(snapshot.number),
    stringValue(totals.igvAmount),
    stringValue(totals.payableAmount),
    stringValue(snapshot.issueDate),
    stringValue(customer.identityType),
    stringValue(customer.identityNumber),
    snapshotSha256,
  ].join('|');
}

export function buildInvoiceHtml(
  snapshot: Record<string, unknown>,
  _qrDataUrl = '',
  _snapshotSha256 = '',
): string {
  // Keep compatibility with callers of the previous renderer. The recovered
  // layout contains neither a QR image nor a visible snapshot hash.
  void _qrDataUrl;
  void _snapshotSha256;
  return renderOriginalInvoice(snapshot);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return '';
}
