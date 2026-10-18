import { diditLaunchMode, diditSessionLaunch } from './didit-session-launch';

describe('Didit session launch compatibility', () => {
  it('keeps existing native behaviour when no operational override is configured', () => {
    expect(diditLaunchMode(undefined)).toBe('native');
    expect(diditSessionLaunch('native', 'test-token', null)).toEqual({ sessionToken: 'test-token', url: '' });
  });

  it.each([null, '', '  '])('refuses a native session without its SDK token (%s)', token => {
    expect(() => diditSessionLaunch('native', token, 'https://verify.didit.me/session/test'))
      .toThrow(expect.objectContaining({ response: expect.objectContaining({ code: 'KYC_SDK_TOKEN_UNAVAILABLE' }) }));
  });

  it('rejects an invalid mode instead of silently launching the wrong flow', () => {
    expect(diditLaunchMode(' HOSTED ')).toBe('hosted');
    expect(() => diditLaunchMode('browser-typo')).toThrow();
    expect(() => diditLaunchMode('')).toThrow();
  });

  it('lets existing apps open the same secure hosted session without a SDK token', () => {
    const url = 'https://verify.didit.me/session/test-session?language=fr';
    expect(diditSessionLaunch('hosted', 'test-token', url)).toEqual({ sessionToken: null, url });
    expect(diditSessionLaunch('hosted', null, 'https://verify.didit.me/fr/session/test-session'))
      .toEqual({ sessionToken: null, url: 'https://verify.didit.me/fr/session/test-session' });
  });

  it.each([null, '', 'http://verify.didit.me/session/test', 'https://verify.didit.me.evil.test/session/test',
    'https://evil.test/session/test', 'https://user:pass@verify.didit.me/session/test',
    'https://verify.didit.me:444/session/test', 'https://verify.didit.me/other/test'])
  ('never hands an unapproved hosted URL to a mobile client (%s)', url => {
    expect(() => diditSessionLaunch('hosted', 'test-token', url)).toThrow();
  });
});
