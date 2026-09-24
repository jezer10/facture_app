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

  it('renders original sections offline with amounts and no template directives', () => {
    const html = buildInvoiceHtml(snapshot);
    expect(html).toContain('Total valor venta gravado');
    expect(html).toContain('Monto total del anticipo');
    expect(html).toContain('CIENTO DIECIOCHO CON 00/100 SOLES');
    expect(html).toContain('S/ 118.00');
    expect(html).toContain('border-2 border-black divide-y');
    expect(html).not.toContain('cdn.tailwindcss.com');
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/\{%|\{\{/u);
    expect(html).not.toContain('Información de la detracción');
  });

  it('uses boleta, DNI, foreign currency and supplied addresses without changing the layout', () => {
    const html = buildInvoiceHtml({
      ...snapshot,
      documentType: '03',
      series: 'B001',
      currency: 'USD',
      issuer: {
        ...snapshot.issuer,
        tradeName: 'Mi negocio',
        address: { street: 'Calle A 123', district: 'Lima', province: 'Lima' },
      },
      customer: { ...snapshot.customer, address: 'Calle B 456' },
    });
    for (const value of [
      'BOLETA ELECTRÓNICA',
      '<td>DNI</td>',
      'USD',
      '$ 118.00',
      'Calle A 123',
      'Calle B 456',
      'Mi negocio',
    ])
      expect(html).toContain(value);
    expect(html).not.toContain('S/ 118.00');
  });

  it('preserves detracciones and never evaluates template syntax from user values', () => {
    const html = buildInvoiceHtml({
      ...snapshot,
      notes: '{{issuer.ruc}}',
      detraction: [
        {
          label: '<Leyenda>',
          service: 'Servicio',
          payment_method: 'Transferencia',
          account_number: '001234',
          percentage: '12',
          amount: '14.16',
        },
      ],
    });
    expect(html).toContain('Información de la detracción');
    expect(html).toContain('&lt;Leyenda&gt;');
    expect(html).toContain('001234');
    expect(html).toContain('{{issuer.ruc}}');
  });

  it('shows line discounts already present in the fiscal snapshot', () => {
    const html = buildInvoiceHtml({
      ...snapshot,
      lines: [{ ...snapshot.lines[0], discountAmount: '10.50' }],
    });
    expect(html).toMatch(/Total descuentos[\s\S]*?S\/ 10\.50/u);
  });
});
