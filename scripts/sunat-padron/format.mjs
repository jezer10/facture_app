export const SOURCE_URL = 'https://www2.sunat.gob.pe/padron_reducido_ruc.zip';
export const SOURCE_PAGE = 'https://www.sunat.gob.pe/descargaPRR/mrc137_padron_reducido.html';
export function parseRow(line) {
  if (!line.trim()) return null;
  const fields = line.split('|');
  if (fields.length === 16 && fields[15].trim() === '') fields.pop();
  if (fields.length !== 15 || !/^\d{11}$/.test(fields[0]))
    throw new Error('Unexpected padrón row format');
  const values = fields.map((value) => {
    const clean = value.replace(/[\x00-\x1f]/g, ' ').trim();
    return clean === '-' ? '' : clean;
  });
  if (!values[1] || !values[2]) throw new Error('Missing taxpayer name or status');
  const address = [
    [values[5], values[6]].filter(Boolean).join(' '),
    values[9] && `Nro. ${values[9]}`,
    values[10] && `Int. ${values[10]}`,
    values[11] && `Lt. ${values[11]}`,
    values[12] && `Dpto. ${values[12]}`,
    values[13] && `Mz. ${values[13]}`,
    values[14] && `Km. ${values[14]}`,
    [values[7], values[8]].filter(Boolean).join(' '),
  ]
    .filter(Boolean)
    .join(' ');
  return [values[0], values[1], values[2], values[3], values[4], address];
}
export function assertHeader(line) {
  if (
    !line.startsWith('RUC|NOMBRE O RAZ') ||
    !line.includes('UBIGEO|') ||
    !line.includes('MANZANA|')
  )
    throw new Error('Unknown padrón header; previous database is preserved');
}
export function assertDate(date) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') ||
    Number.isNaN(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date
  )
    throw new Error('Use a valid --source-date YYYY-MM-DD');
}
