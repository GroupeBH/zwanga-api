/**
 * SMS templates intentionally use printable ASCII. This avoids mojibake on
 * legacy SMS gateways without removing accents from French words or app text.
 * Keep %OTP% unchanged: Keccel replaces it with the generated code.
 */
export const OTP_SMS_MESSAGES = {
  default: 'Votre code Zwanga est : %OTP%. Ne partagez ce code avec personne.',
  verification:
    'Votre code de confirmation Zwanga est : %OTP%. Ne partagez ce code avec personne.',
  pinReset:
    'Votre code pour changer le PIN Zwanga est : %OTP%. Ne partagez ce code avec personne.',
  adminBootstrap:
    'Votre code pour activer le compte administrateur Zwanga est : %OTP%. Ne partagez ce code avec personne.',
} as const;
