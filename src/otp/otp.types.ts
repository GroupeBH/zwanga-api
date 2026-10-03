export type OtpPurpose = 'phone_verification' | 'pin_reset' | 'admin_bootstrap';

export type OtpProvider = 'keccel' | 'didit';

export type OtpChallenge =
  | { provider: 'keccel' }
  | { provider: 'didit'; requestId: string; vendorData: string };

export interface DiditActiveOtp {
  purpose: OtpPurpose;
  requestId: string;
  vendorData: string;
  expiresAt: number;
}

export interface SendOtpResponse {
  success: boolean;
  message: string;
  status?: string;
}

export interface VerifyOtpResponse {
  valid: boolean;
  status: string;
}
