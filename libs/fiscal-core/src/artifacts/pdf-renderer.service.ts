import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import QRCode from 'qrcode';

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
    const qr = await QRCode.toDataURL(buildQrPayload(snapshot, snapshotSha256), {
      errorCorrectionLevel: 'M',
      margin: 0,
      width: 180,
    });
    const browser = await this.getBrowser();
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.route('**/*', (route) => route.abort());
    try {
      await page.setContent(buildInvoiceHtml(snapshot, qr, snapshotSha256), {
        waitUntil: 'domcontentloaded',
      });
      return await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '12mm', right: '12mm', bottom: '12mm', left: '12mm' },
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
  qrDataUrl: string,
  snapshotSha256 = '',
): string {
  const issuer = record(snapshot.issuer);
  const customer = record(snapshot.customer);
  const totals = record(snapshot.totals);
  const lines = Array.isArray(snapshot.lines) ? snapshot.lines.map(record) : [];
  const rows = lines
    .map(
      (line) => `<tr>
        <td>${escapeHtml(stringValue(line.quantity))}</td>
        <td>${escapeHtml(stringValue(line.unitCode))}</td>
        <td>${escapeHtml(stringValue(line.description))}</td>
        <td class="number">${escapeHtml(stringValue(line.unitValue ?? line.referenceUnitValue))}</td>
        <td class="number">${escapeHtml(stringValue(line.payableAmount))}</td>
      </tr>`,
    )
    .join('');
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><style>
  body{font-family:Arial,sans-serif;color:#172033;font-size:11px;margin:0}
  header{display:flex;justify-content:space-between;gap:24px;border-bottom:2px solid #253b80;padding-bottom:14px}
  h1{font-size:18px;margin:0 0 5px}.cpe{border:2px solid #253b80;padding:12px;text-align:center;min-width:220px}
  section{margin-top:16px}.party{background:#f4f6fa;padding:10px;border-radius:4px}
  table{width:100%;border-collapse:collapse;margin-top:16px}th,td{padding:7px;border:1px solid #d7dce6}
  th{background:#253b80;color:white;text-align:left}.number{text-align:right}.totals{margin-left:auto;width:280px}
  .totals div{display:flex;justify-content:space-between;padding:4px}.grand{font-size:14px;font-weight:bold;border-top:2px solid #253b80}
  footer{display:flex;align-items:flex-end;gap:18px;margin-top:22px;color:#4b5563}footer img{width:120px;height:120px}
</style></head><body>
<header><div><h1>${escapeHtml(stringValue(issuer.legalName))}</h1><div>RUC ${escapeHtml(stringValue(issuer.ruc))}</div></div>
<div class="cpe"><strong>${escapeHtml(documentLabel(stringValue(snapshot.documentType)))}</strong><br>
${escapeHtml(stringValue(snapshot.series))}-${escapeHtml(stringValue(snapshot.number))}</div></header>
<section class="party"><strong>Cliente:</strong> ${escapeHtml(stringValue(customer.legalName))}<br>
<strong>Documento:</strong> ${escapeHtml(stringValue(customer.identityNumber))}<br>
<strong>Fecha:</strong> ${escapeHtml(stringValue(snapshot.issueDate))} · <strong>Moneda:</strong> ${escapeHtml(stringValue(snapshot.currency))}</section>
<table><thead><tr><th>Cant.</th><th>Unidad</th><th>Descripción</th><th>V. unitario</th><th>Importe</th></tr></thead><tbody>${rows}</tbody></table>
<section class="totals"><div><span>Op. gravada</span><span>${escapeHtml(stringValue(totals.taxableAmount))}</span></div>
<div><span>IGV</span><span>${escapeHtml(stringValue(totals.igvAmount))}</span></div>
<div class="grand"><span>Total</span><span>${escapeHtml(stringValue(totals.payableAmount))}</span></div></section>
<footer><img src="${escapeHtml(qrDataUrl)}" alt="Código QR"><div>Representación impresa del comprobante electrónico.<br>
Hash: ${escapeHtml(snapshotSha256)}</div></footer>
</body></html>`;
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

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function documentLabel(type: string): string {
  return (
    (
      {
        '01': 'FACTURA ELECTRÓNICA',
        '03': 'BOLETA ELECTRÓNICA',
        '07': 'NOTA DE CRÉDITO',
        '08': 'NOTA DE DÉBITO',
      } as Record<string, string>
    )[type] ?? 'COMPROBANTE ELECTRÓNICO'
  );
}
