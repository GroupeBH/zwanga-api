import { BadRequestException } from '@nestjs/common';
import type { ProServiceCase } from './pro-service.entities';
import { DOCUMENT_OPTIONS, ServiceApplication, ServiceCode } from './pro-service.types';

export function canEditDocumentCase(item: Pick<ProServiceCase, 'serviceCode' | 'status' | 'acceptedAt'>) {
  return item.serviceCode === 'documents';
}

export function documentCaseEditMode(item: Pick<ProServiceCase, 'status' | 'acceptedAt' | 'acceptedQuoteVersion'>): 'full' | 'add_documents' {
  return item.acceptedAt || item.acceptedQuoteVersion != null || ['accepted', 'processing', 'ready', 'completed'].includes(item.status)
    ? 'add_documents' : 'full';
}

export function normalizeServiceApplication(serviceCode: ServiceCode, app: ServiceApplication, consent: boolean): ServiceApplication {
  if (consent !== true) throw new BadRequestException('Votre accord pour être contacté est nécessaire.');
  const application = {
    fullName: app.fullName.trim(), phone: app.phone.trim(),
    vehicleDescription: app.vehicleDescription.trim(), plate: app.plate?.trim().toUpperCase() || '',
    documents: [...app.documents].sort(), description: app.description.trim(),
  };
  if (application.fullName.length < 3 || application.phone.replace(/\D/g, '').length < 8)
    throw new BadRequestException('Renseignez votre nom et un numéro de contact valide.');
  if (serviceCode === 'documents' && (!application.documents.length || application.documents.some(code => !DOCUMENT_OPTIONS.some(([known]) => known === code))))
    throw new BadRequestException('Choisissez au moins un document proposé.');
  if (serviceCode !== 'documents' && application.description.length < 10)
    throw new BadRequestException('Précisez votre besoin.');
  return application;
}

export function sameApplication(left: ServiceApplication, right: ServiceApplication) {
  return Object.keys(right).every(key => JSON.stringify(left[key]) === JSON.stringify(right[key]));
}
