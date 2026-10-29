export type OtpPurpose = 'phone_verification' | 'pin_reset' | 'admin_bootstrap';

export type OtpProvider = 'keccel' | 'didit' | 'mobishastra';

export interface MobishastraChallenge {
  provider: 'mobishastra';
  requestId: string;
  state: 'pending' | 'sent' | 'verified';
  codeHash?: string;
  proofHash?: string;
  attemptsRemaining: number;
}

export type OtpChallenge =
  | { provider: 'keccel'; requestId?: string }
  | { provider: 'didit'; requestId: string; vendorData: string }
  | MobishastraChallenge;

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
  codeLength?: number;
  expiresInSeconds?: number;
}

export interface VerifyOtpResponse {
  valid: boolean;
  status: string;
  verificationToken?: string;
  expiresInSeconds?: number;
}
