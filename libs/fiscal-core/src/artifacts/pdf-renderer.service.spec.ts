import { buildInvoiceHtml, buildQrPayload } from './pdf-renderer.service';

const snapshot = {
  currency: 'PEN',
  customer: { identityNumber: '12345678', identityType: '1', legalName: '<Cliente>' },
  documentType: '01',
  issueDate: '2026-08-22',
  issuer: { legalName: 'Empresa & Asociados', ruc: '20131312955' },
  lines: [
    {
      description: '<script>alert(1)</script>',
      payableAmount: '118.00',
      quantity: '1',
      unitCode: 'NIU',
      unitValue: '100.00',
    },
  ],
  number: '42',
  series: 'F001',
  totals: { igvAmount: '18.00', payableAmount: '118.00', taxableAmount: '100.00' },
};

describe('PDF fiscal helpers', () => {
  it('builds the SUNAT QR value in stable field order', () => {
    expect(buildQrPayload(snapshot, 'abc123')).toBe(
      '20131312955|01|F001|42|18.00|118.00|2026-08-22|1|12345678|abc123',
    );
  });

  it('escapes untrusted invoice content in HTML', () => {
    const html = buildInvoiceHtml(snapshot, 'data:image/png;base64,abc');
    expect(html).toContain('Empresa &amp; Asociados');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});
