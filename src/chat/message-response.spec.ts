import { messageResponse } from './message-response';
import { Message } from './entities/message.entity';
import { matchesStoredToken, tokenFingerprint } from '../auth/token-fingerprint';

describe('Credential transport and storage boundaries', () => {
  it('only exposes allowed message/sender fields, including entities saved in memory', () => {
    const result = messageResponse({ id: 'message', content: 'Bonjour', sender: {
      id: 'sender', firstName: 'Nom', password: 'secret', accessToken: 'access',
      refreshToken: 'refresh', fcmToken: 'push', phone: 'private', kycDocuments: [],
    }, conversation: { internal: true } } as unknown as Message);
    expect(result.sender).toEqual({ id: 'sender', firstName: 'Nom', lastName: undefined, profilePicture: undefined });
    for (const key of ['password', 'accessToken', 'refreshToken', 'fcmToken', 'phone', 'kycDocuments', 'conversation']) {
      expect(JSON.stringify(result)).not.toContain(`"${key}"`);
    }
  });
  it('accepts a legacy token or its fingerprint, never a different token', () => {
    expect(matchesStoredToken('old-token', 'old-token')).toBe(true);
    expect(matchesStoredToken(tokenFingerprint('old-token'), 'old-token')).toBe(true);
    expect(matchesStoredToken(tokenFingerprint('old-token'), 'other')).toBe(false);
    expect(matchesStoredToken(null, 'old-token')).toBe(false);
  });
});
