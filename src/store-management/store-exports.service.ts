import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn } from 'class-validator';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { buildSpreadsheet } from '../admin/spreadsheet';
import { StoreRangeDto, storeRange } from './store.dto';
import { StoreService } from './store.service';
import { StoreRepository } from './store.repository';
import { storeAudit } from './store-operations.service';

const TOPICS = [
  'global',
  'google',
  'apple',
  'acquisition',
  'conversion',
  'reviews',
  'stability',
  'versions',
] as const;
export class StoreExportDto extends StoreRangeDto {
  @ApiProperty({ enum: TOPICS })
  @Transform(({ obj, key }) => obj[key])
  @IsIn(TOPICS)
  topic: (typeof TOPICS)[number];
  @ApiProperty({ enum: ['csv', 'xls', 'pdf'] })
  @Transform(({ obj, key }) => obj[key])
  @IsIn(['csv', 'xls', 'pdf'])
  format: 'csv' | 'xls' | 'pdf';
}
export function storeCsv(headers: string[], rows: unknown[][]) {
  const cell = (v: unknown) => {
    let value = v == null ? '' : String(v);
    if (/^[\s\u0000-\u001f]*[=+@-]/.test(value) || /^[\t\r\n]/.test(value))
      value = "'" + value;
    return `"${value.replace(/"/g, '""')}"`;
  };
  return Buffer.from(
    '\uFEFF' +
      [headers, ...rows].map((row) => row.map(cell).join(',')).join('\r\n'),
    'utf8',
  );
}
export async function storeSummaryPdf(title: string, lines: string[]) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setAuthor('Zwanga');
  const font = await pdf.embedFont(StandardFonts.Helvetica),
    bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage([595.28, 841.89]),
    y = 785,
    pageNo = 1;
  const heading = () => {
    page.drawText('ZWANGA / STORES', {
      x: 40,
      y,
      font: bold,
      size: 18,
      color: rgb(0.9, 0.32, 0.08),
    });
    y -= 30;
    page.drawText(title, { x: 40, y, font: bold, size: 12 });
    y -= 28;
    page.drawText(`Page ${pageNo}`, {
      x: 500,
      y: 24,
      font,
      size: 9,
      color: rgb(0.4, 0.4, 0.4),
    });
  };
  heading();
  for (const original of lines.slice(0, 1000)) {
    // Summary contains generated labels/metrics only. Unsupported glyphs are made explicit.
    const safe = [...original]
      .map((c) => {
        try {
          font.encodeText(c);
          return c;
        } catch {
          return '?';
        }
      })
      .join('');
    const words = safe.split(/\s+/);
    let line = '';
    const wrapped: string[] = [];
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, 10) > 510 && line) {
        wrapped.push(line);
        line = word;
      } else line = next;
    }
    wrapped.push(line);
    for (const text of wrapped) {
      if (y < 60) {
        page = pdf.addPage([595.28, 841.89]);
        y = 785;
        pageNo++;
        heading();
      }
      page.drawText(text, {
        x: 40,
        y,
        font,
        size: 10,
        maxWidth: 515,
        wordBreaks: [' ', '_', '.'],
        lineHeight: 14,
      });
      y -= 16;
    }
    y -= 5;
  }
  return Buffer.from(await pdf.save());
}
@Injectable()
export class StoreExportsService {
  constructor(
    private readonly stores: StoreService,
    private readonly repository: StoreRepository,
  ) {}
  catalog() {
    return {
      topics: TOPICS,
      formats: ['csv', 'xls', 'pdf'],
      maximumRows: 10000,
      pdf: 'summary_only',
      excel: 'SpreadsheetML .xls (existing Zwanga generator)',
    };
  }
  async export(actor: string, permissions: string[], dto: StoreExportDto) {
    const required =
      dto.topic === 'reviews'
        ? 'store.reviews.read'
        : dto.topic === 'versions'
          ? 'store.versions.read'
          : dto.topic === 'stability'
            ? 'store.vitals.read'
            : 'store.analytics.read';
    if (!permissions.includes(required))
      throw new ForbiddenException('Accès requis aux données du rapport.');
    const range = storeRange(dto);
    const query = {
      ...dto,
      ...range,
      platform:
        dto.topic === 'google'
          ? ('google' as const)
          : dto.topic === 'apple'
            ? ('apple' as const)
            : dto.platform,
    };
    let headers: string[], rows: unknown[][], summary: string[];
    if (
      dto.topic === 'reviews' ||
      dto.topic === 'versions' ||
      dto.topic === 'stability'
    ) {
      const kind =
        dto.topic === 'reviews'
          ? 'review'
          : dto.topic === 'versions'
            ? 'release'
            : 'performance';
      headers = ['platform', 'externalId', 'observedAt', 'data'];
      rows = [];
      for (let page = 1; page <= 100; page++) {
        const result = await this.stores.records({
          page,
          limit: 100,
          platform: query.platform,
          kind,
          ...(kind === 'review' ? range : {}),
        });
        if (result.total > 10000)
          throw new BadRequestException(
            'Trop de lignes : réduisez la période ou la plateforme.',
          );
        rows.push(
          ...result.items.map((r) => [
            r.platform,
            r.externalId,
            r.syncedAt.toISOString(),
            JSON.stringify(r.content),
          ]),
        );
        if (page * 100 >= result.total) break;
      }
      summary = [
        `Période demandée : ${range.from} au ${range.to}`,
        `${rows.length} éléments importés.`,
        'Les versions et indicateurs techniques sont un état observé ; la période filtre uniquement les avis.',
        'Le détail est disponible dans les exports CSV et Excel.',
      ];
    } else {
      const dashboard = (await this.stores.dashboard(query)) as any;
      headers = [
        'platform',
        'date',
        'metric',
        'value',
        'unit',
        'source',
        'importedAt',
      ];
      rows = dashboard.series.map((r: any) => {
        const d = dashboard.definitions.find((v: any) => v.id === r.metric);
        return [
          r.platform,
          r.date,
          r.metric,
          r.value,
          d?.unit,
          d?.source,
          r.importedAt,
        ];
      });
      if (dto.topic === 'conversion') {
        headers = [
          'registrationDate',
          'registrations',
          'driversCurrentRole',
          'passengersCurrentRole',
          'kycSubmittedCurrentState',
          'kycApprovedCurrentState',
          'firstTripCompletedCurrentState',
        ];
        rows = dashboard.cohorts.map((r: any) => [
          r.date,
          r.registrations,
          r.drivers,
          r.passengers,
          r.kycSubmitted,
          r.kycApproved,
          r.firstTripCompleted,
        ]);
      }
      summary = [
        `Période : ${range.from} au ${range.to} / généré le ${dashboard.generatedAt}`,
        ...dashboard.notes,
      ];
      for (const definition of dashboard.definitions) {
        const values = dashboard.series.filter(
          (s: any) => s.metric === definition.id,
        );
        if (!values.length) continue;
        const last = values[values.length - 1];
        const value =
          definition.aggregation === 'sum'
            ? values.reduce((n: number, v: any) => n + Number(v.value), 0)
            : Number(last.value);
        summary.push(
          `${definition.id} : ${value} ${definition.unit} (${definition.aggregation === 'sum' ? 'somme des jours disponibles' : 'dernier jour disponible : ' + last.date}). Source : ${definition.source}.`,
        );
      }
      const registrations = dashboard.cohorts.reduce(
        (n: number, c: any) => n + c.registrations,
        0,
      );
      summary.push(
        `Zwanga : ${registrations} inscriptions dans la période. Les résultats KYC/premier trajet représentent leur état actuel, sans attribution individuelle aux stores.`,
      );
    }
    const buffer =
      dto.format === 'pdf'
        ? await storeSummaryPdf(`Rapport ${dto.topic}`, summary)
        : dto.format === 'xls'
          ? buildSpreadsheet('Zwanga Stores', headers, rows as any)
          : storeCsv(headers, rows);
    await storeAudit(
      this.repository.db.manager,
      actor,
      'report.export',
      dto.topic,
      { format: dto.format, ...range, rows: rows.length },
    );
    return {
      buffer,
      filename: `zwanga-stores-${dto.topic}-${range.to}.${dto.format}`,
      contentType:
        dto.format === 'pdf'
          ? 'application/pdf'
          : dto.format === 'xls'
            ? 'application/vnd.ms-excel; charset=utf-8'
            : 'text/csv; charset=utf-8',
    };
  }
}
