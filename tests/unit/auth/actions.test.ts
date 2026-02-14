// vitest globals enabled

vi.mock('next/cache', () => ({
  revalidatePath: () => {},
  updateTag: () => {},
}));

vi.mock('@/i18n/navigation', () => ({
  redirect: (path: string) => {
    (globalThis as any).__redirectCalls = [...((globalThis as any).__redirectCalls || []), path];
    throw new Error('__REDIRECT__');
  },
}));

vi.mock('next-intl/server', () => ({
  getLocale: async () => 'en',
  // i18n.ts imports getRequestConfig at module scope
  getRequestConfig: (cb: any) => ({}) as any,
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-forwarded-for': '198.51.100.23' }),
}));

const sessionMock = {
  isLoggedIn: false,
  username: undefined as any,
  save: vi.fn(),
  destroy: vi.fn(),
};

vi.mock('@/lib/session', () => ({
  getSession: async () => sessionMock,
}));

describe('auth actions', () => {
  const env = { ...process.env };
  beforeEach(() => {
    vi.resetModules();
    (globalThis as any).__redirectCalls = [];
    (globalThis as any)._failedLoginAttempts = undefined;
    sessionMock.isLoggedIn = false;
    sessionMock.username = undefined;
    sessionMock.save.mockReset();
    sessionMock.destroy.mockReset();
  });
  afterEach(() => { process.env = { ...env }; });

  it('login: valid credentials set session and redirect safely', async () => {
    process.env.AUTH_USERNAME = 'user';
    process.env.AUTH_PASSWORD = 'pass';

    const { login } = await import('@/app/auth/actions');
    const fd = new FormData();
    fd.set('username', 'user');
    fd.set('password', 'pass');
    fd.set('next', '/en/test');

    await expect(login(undefined, fd)).rejects.toThrow('__REDIRECT__');
    expect(sessionMock.isLoggedIn).toBe(true);
    expect(sessionMock.username).toBe('user');
    // redirected to path without locale prefix
    const calls = (globalThis as any).__redirectCalls;
    expect(calls[calls.length - 1]).toBe('/test');
  });

  it('login: invalid credentials returns error', async () => {
    process.env.AUTH_USERNAME = 'user';
    process.env.AUTH_PASSWORD = 'pass';
    const { login } = await import('@/app/auth/actions');
    const fd = new FormData();
    fd.set('username', 'user');
    fd.set('password', 'wrong');
    const res = await login(undefined, fd);
    expect(res).toEqual({ errorKey: 'error_invalid_credentials' });
  });

  it('login: invalid input types return error', async () => {
    process.env.AUTH_USERNAME = 'user';
    process.env.AUTH_PASSWORD = 'pass';
    const { login } = await import('@/app/auth/actions');
    const fd = new FormData();
    fd.set('username', '');
    fd.set('password', '');
    const res = await login(undefined, fd);
    expect(res).toEqual({ errorKey: 'error_invalid_credentials' });
  });

  it('login: unsafe next redirects to root', async () => {
    process.env.AUTH_USERNAME = 'user';
    process.env.AUTH_PASSWORD = 'pass';
    const { login } = await import('@/app/auth/actions');
    const fd = new FormData();
    fd.set('username', 'user');
    fd.set('password', 'pass');
    fd.set('next', 'https://evil.com/whatever');
    await expect(login(undefined, fd)).rejects.toThrow('__REDIRECT__');
    const calls = (globalThis as any).__redirectCalls;
    expect(calls[calls.length - 1]).toBe('/');
  });

  it('logout: destroys session and redirects to login path', async () => {
    const { logout } = await import('@/app/auth/actions');
    await expect(logout()).rejects.toThrow('__REDIRECT__');
    expect(sessionMock.destroy).toHaveBeenCalled();
    const calls = (globalThis as any).__redirectCalls;
    expect(calls[calls.length - 1]).toMatch(/\/login|\/anmelden/);
  });

  it('login: applies lockout after too many failed attempts', async () => {
    process.env.AUTH_USERNAME = 'user';
    process.env.AUTH_PASSWORD = 'pass';
    process.env.AUTH_MAX_LOGIN_ATTEMPTS = '2';
    process.env.AUTH_LOGIN_WINDOW_SECONDS = '60';
    process.env.AUTH_LOGIN_LOCKOUT_SECONDS = '60';

    const { login } = await import('@/app/auth/actions');

    const firstAttempt = new FormData();
    firstAttempt.set('username', 'user');
    firstAttempt.set('password', 'wrong');
    const firstResult = await login(undefined, firstAttempt);
    expect(firstResult).toEqual({ errorKey: 'error_invalid_credentials' });

    const secondAttempt = new FormData();
    secondAttempt.set('username', 'user');
    secondAttempt.set('password', 'wrong-again');
    const secondResult = await login(undefined, secondAttempt);
    expect(secondResult).toEqual({ errorKey: 'error_too_many_attempts' });

    const correctAttempt = new FormData();
    correctAttempt.set('username', 'user');
    correctAttempt.set('password', 'pass');
    const lockedResult = await login(undefined, correctAttempt);
    expect(lockedResult).toEqual({ errorKey: 'error_too_many_attempts' });
  });

  it('login: logs failed attempts and active lockout details', async () => {
    process.env.AUTH_USERNAME = 'user';
    process.env.AUTH_PASSWORD = 'pass';
    process.env.AUTH_MAX_LOGIN_ATTEMPTS = '2';
    process.env.AUTH_LOGIN_WINDOW_SECONDS = '60';
    process.env.AUTH_LOGIN_LOCKOUT_SECONDS = '60';

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { login } = await import('@/app/auth/actions');

      const firstAttempt = new FormData();
      firstAttempt.set('username', 'user');
      firstAttempt.set('password', 'wrong');
      await login(undefined, firstAttempt);

      const secondAttempt = new FormData();
      secondAttempt.set('username', 'user');
      secondAttempt.set('password', 'wrong-again');
      await login(undefined, secondAttempt);

      const blockedAttempt = new FormData();
      blockedAttempt.set('username', 'user');
      blockedAttempt.set('password', 'pass');
      await login(undefined, blockedAttempt);

      const warnLines = warnSpy.mock.calls.map(([line]) => String(line));
      expect(warnLines.some((line) => line.includes('attempts=1/2'))).toBe(true);
      expect(warnLines.some((line) => line.includes('lockout activated'))).toBe(true);
      expect(warnLines.some((line) => line.includes('active lockout'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('login: logs when lockout expires and access is unblocked', async () => {
    process.env.AUTH_USERNAME = 'user';
    process.env.AUTH_PASSWORD = 'pass';
    process.env.AUTH_MAX_LOGIN_ATTEMPTS = '2';
    process.env.AUTH_LOGIN_WINDOW_SECONDS = '120';
    process.env.AUTH_LOGIN_LOCKOUT_SECONDS = '1';

    const infoSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      const { login } = await import('@/app/auth/actions');

      nowSpy.mockReturnValue(0);
      const firstAttempt = new FormData();
      firstAttempt.set('username', 'user');
      firstAttempt.set('password', 'wrong');
      await login(undefined, firstAttempt);

      nowSpy.mockReturnValue(100);
      const secondAttempt = new FormData();
      secondAttempt.set('username', 'user');
      secondAttempt.set('password', 'wrong-again');
      await login(undefined, secondAttempt);

      nowSpy.mockReturnValue(1_500);
      const successfulAttempt = new FormData();
      successfulAttempt.set('username', 'user');
      successfulAttempt.set('password', 'pass');
      await expect(login(undefined, successfulAttempt)).rejects.toThrow('__REDIRECT__');

      const infoLines = infoSpy.mock.calls.map(([line]) => String(line));
      expect(infoLines.some((line) => line.includes('Lockout expired'))).toBe(true);
      expect(infoLines.some((line) => line.includes('Access unblocked'))).toBe(true);
    } finally {
      nowSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });
});
