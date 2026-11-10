import { BadRequestException } from '@nestjs/common';

/** Un conducteur peut créer son compte avec l'une des écritures acceptées par Zwanga. */
export function canonicalFieldPhone(input: string): string {
  const phone = input.trim();
  const digits = phone.startsWith('+') ? phone.slice(1) : phone;
  const local = digits.startsWith('00243') && digits.length === 14 ? digits.slice(5)
    : digits.startsWith('243') && digits.length === 12 ? digits.slice(3)
    : digits.startsWith('0') && digits.length === 10 ? digits.slice(1)
    : digits.length === 9 ? digits : '';
  if (!/^[89][0-9]{8}$/.test(local)) throw new BadRequestException('Numéro mobile RDC invalide');
  return `+243${local}`;
}

export function fieldPhoneVariants(canonical: string): string[] {
  const local = canonical.slice(4);
  return [canonical, `243${local}`, `00243${local}`, `0${local}`, local];
}
