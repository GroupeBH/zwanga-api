import { ValidationPipe } from '@nestjs/common';
import { normalizeServiceApplication } from './document-case.policy';
import { CreateServiceCaseDto } from './pro-service.dto';
import { ProServiceStore } from './pro-service.store';
import { DOCUMENT_OPTIONS } from './pro-service.types';

const application = { fullName: 'Test applicant', phone: '+243812345678', vehicleDescription: 'Toyota Noah', plate: '4821aq01', description: '' };

describe('Zwanga Services document options', () => {
  it('offers the HVK sticker in the documents catalogue served to zwanga-admin and the public form', async () => {
    const offerings = [{ code: 'documents', name: 'Documents et autorisations', description: '', availability: 'open', terms: null }];
    const store = new ProServiceStore({ getRepository: () => ({ find: jest.fn().mockResolvedValue(offerings) }) } as any);
    const [documents] = await store.catalogue(true);
    expect(documents.documentOptions).toContainEqual({ code: 'autocollant-hvk', label: 'Autocollant HVK (Hôtel de Ville de Kinshasa)' });
  });

  it('accepts a request for the HVK sticker', () => {
    expect(normalizeServiceApplication('documents', { ...application, documents: ['autocollant-hvk'] }, true).documents).toEqual(['autocollant-hvk']);
  });

  it('still lets a request include every proposed document at once', async () => {
    const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
    const all = DOCUMENT_OPTIONS.map(([code]) => code);
    const body = { serviceCode: 'documents', submissionKey: '00000000-0000-4000-8000-000000000001', contactConsent: true, application: { ...application, documents: all } };
    await expect(pipe.transform(body, { type: 'body', metatype: CreateServiceCaseDto })).resolves.toBeInstanceOf(CreateServiceCaseDto);
    expect(normalizeServiceApplication('documents', { ...application, documents: all }, true).documents).toHaveLength(all.length);
  });
});
