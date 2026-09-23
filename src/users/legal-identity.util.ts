export const normalizeLegalName = (value?: string | null): string =>
  String(value ?? '')
    .normalize('NFC')
    .trim()
    .replace(/\s+/g, ' ');

const normalizeLegalNameForComparison = (value?: string | null): string =>
  normalizeLegalName(value)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('fr');

export const areLegalNamesEquivalent = (
  firstValue?: string | null,
  secondValue?: string | null,
): boolean =>
  normalizeLegalNameForComparison(firstValue) ===
  normalizeLegalNameForComparison(secondValue);
