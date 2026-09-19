export type SpreadsheetFile = {
  buffer: Buffer;
  filename: string;
  contentType: string;
};

const XLS_CONTENT_TYPE = 'application/vnd.ms-excel; charset=utf-8';

const escapeXml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

const cell = (value: string): string =>
  `<Cell><Data ss:Type="String">${escapeXml(value)}</Data></Cell>`;

const rowXml = (values: readonly string[]): string =>
  `<Row>${values.map(cell).join('')}</Row>`;

export const spreadsheetCell = (
  value: string | number | boolean | Date | null | undefined,
): string => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  }
  if (typeof value === 'boolean') {
    return value ? 'Oui' : 'Non';
  }
  if (value == null) {
    return '';
  }
  return String(value);
};

export const buildSpreadsheet = (
  sheetName: string,
  headers: readonly string[],
  rows: Array<Array<string | number | boolean | Date | null | undefined>>,
): Buffer => {
  const dataRows = rows.map((row) => rowXml(row.map(spreadsheetCell)));
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  <Worksheet ss:Name="${escapeXml(sheetName.slice(0, 31))}">
    <Table>
      ${rowXml(headers)}
      ${dataRows.join('\n      ')}
    </Table>
  </Worksheet>
</Workbook>
`;

  return Buffer.from(`\uFEFF${xml}`, 'utf8');
};

export const spreadsheetAttachment = (
  filename: string,
  buffer: Buffer,
): SpreadsheetFile => ({
  buffer,
  filename,
  contentType: XLS_CONTENT_TYPE,
});

export const datedFilename = (prefix: string, now = new Date()) =>
  `${prefix}-${now.toISOString().slice(0, 10)}.xls`;

export const spreadsheetHeaders = (file: SpreadsheetFile): Record<string, string> => ({
  'Content-Type': file.contentType,
  'Content-Disposition': `attachment; filename="${file.filename}"`,
  'Cache-Control': 'no-store',
});
