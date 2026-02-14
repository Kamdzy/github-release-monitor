"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { getLocale } from "next-intl/server";
import { pathnames } from "@/i18n/routing";
import { logger } from "@/lib/logger";
import { redirectLocalized } from "@/lib/redirect-localized";
import { getSession } from "@/lib/session";

type LoginAttemptState = {
  failures: number;
  firstFailedAt: number;
  lastFailedAt: number;
  lockedUntil: number;
};

type FailedAttemptResult = {
  lockoutTriggered: boolean;
  failures: number;
  attemptsRemaining: number;
  lockoutRemainingSeconds: number;
};

type FailedAttemptReason = "invalid_input" | "invalid_credentials";

declare global {
  var _failedLoginAttempts: Map<string, LoginAttemptState> | undefined;
}

global._failedLoginAttempts ??= new Map<string, LoginAttemptState>();
const failedLoginAttempts = global._failedLoginAttempts as Map<
  string,
  LoginAttemptState
>;

const DEFAULT_LOGIN_ATTEMPTS = 5;
const DEFAULT_ATTEMPT_WINDOW_SECONDS = 15 * 60;
const DEFAULT_LOCKOUT_SECONDS = 15 * 60;

function parseBoundedIntegerEnv(
  name: string,
  defaultValue: number,
  min: number,
  max: number,
): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return defaultValue;
  const rounded = Math.round(parsed);
  return Math.min(Math.max(rounded, min), max);
}

const loginAttemptLimit = parseBoundedIntegerEnv(
  "AUTH_MAX_LOGIN_ATTEMPTS",
  DEFAULT_LOGIN_ATTEMPTS,
  1,
  20,
);
const loginAttemptWindowSeconds = parseBoundedIntegerEnv(
  "AUTH_LOGIN_WINDOW_SECONDS",
  DEFAULT_ATTEMPT_WINDOW_SECONDS,
  1,
  24 * 60 * 60,
);
const loginLockoutSeconds = parseBoundedIntegerEnv(
  "AUTH_LOGIN_LOCKOUT_SECONDS",
  DEFAULT_LOCKOUT_SECONDS,
  1,
  24 * 60 * 60,
);
const loginAttemptWindowMs = loginAttemptWindowSeconds * 1_000;
const loginLockoutMs = loginLockoutSeconds * 1_000;

async function getLoginRequestContext(username: string): Promise<{
  rateLimitKey: string;
  clientIp: string;
}> {
  const headerStore = await headers();
  const forwardedFor = headerStore.get("x-forwarded-for");
  const firstForwardedIp = forwardedFor?.split(",")[0]?.trim();
  const realIp = headerStore.get("x-real-ip")?.trim();
  const ip = (firstForwardedIp || realIp || "unknown").slice(0, 128);
  const normalizedUsername = username.trim().toLowerCase().slice(0, 128);
  return {
    rateLimitKey: `${ip}:${normalizedUsername || "unknown"}`,
    clientIp: ip,
  };
}

function pruneFailedLoginState(now: number) {
  for (const [key, state] of failedLoginAttempts.entries()) {
    if (state.lockedUntil > now) continue;
    if (now - state.lastFailedAt > loginAttemptWindowMs) {
      failedLoginAttempts.delete(key);
    }
  }
}

function isRateLimited(key: string, now: number): boolean {
  const state = failedLoginAttempts.get(key);
  if (!state) return false;
  if (state.lockedUntil > now) {
    return true;
  }
  if (
    state.lockedUntil <= now &&
    now - state.lastFailedAt > loginAttemptWindowMs
  ) {
    failedLoginAttempts.delete(key);
  }
  return false;
}

function getLockoutRemainingSeconds(key: string, now: number): number {
  const state = failedLoginAttempts.get(key);
  if (!state || state.lockedUntil <= now) return 0;
  return Math.ceil((state.lockedUntil - now) / 1_000);
}

function registerFailedAttempt(key: string, now: number): FailedAttemptResult {
  const existing = failedLoginAttempts.get(key);
  if (!existing || now - existing.firstFailedAt > loginAttemptWindowMs) {
    const failures = 1;
    const attemptsRemaining = Math.max(loginAttemptLimit - failures, 0);
    failedLoginAttempts.set(key, {
      failures,
      firstFailedAt: now,
      lastFailedAt: now,
      lockedUntil: 0,
    });
    return {
      lockoutTriggered: false,
      failures,
      attemptsRemaining,
      lockoutRemainingSeconds: 0,
    };
  }

  const failures = existing.failures + 1;
  const lockedUntil =
    failures >= loginAttemptLimit ? now + loginLockoutMs : existing.lockedUntil;
  const lockoutTriggered = lockedUntil > now;
  const attemptsRemaining = Math.max(loginAttemptLimit - failures, 0);
  const lockoutRemainingSeconds = lockoutTriggered
    ? Math.ceil((lockedUntil - now) / 1_000)
    : 0;
  failedLoginAttempts.set(key, {
    failures,
    firstFailedAt: existing.firstFailedAt,
    lastFailedAt: now,
    lockedUntil,
  });
  return {
    lockoutTriggered,
    failures,
    attemptsRemaining,
    lockoutRemainingSeconds,
  };
}

function clearFailedAttempts(key: string) {
  failedLoginAttempts.delete(key);
}

function clearExpiredLockout(
  key: string,
  now: number,
): { wasCleared: boolean; failures: number } {
  const state = failedLoginAttempts.get(key);
  if (!state) return { wasCleared: false, failures: 0 };
  if (state.lockedUntil <= 0 || state.lockedUntil > now) {
    return { wasCleared: false, failures: 0 };
  }

  failedLoginAttempts.set(key, {
    ...state,
    lockedUntil: 0,
  });
  return { wasCleared: true, failures: state.failures };
}

function logFailedLoginAttempt(
  username: string,
  clientIp: string,
  reason: FailedAttemptReason,
  result: FailedAttemptResult,
) {
  const reasonLabel =
    reason === "invalid_input" ? "invalid input" : "invalid credentials";

  if (result.lockoutTriggered) {
    logger
      .withScope("Auth")
      .warn(
        `Failed login attempt for username='${username}' from ip='${clientIp}' (${reasonLabel}); lockout activated for ${result.lockoutRemainingSeconds}s after ${result.failures}/${loginAttemptLimit} failed attempts.`,
      );
    return;
  }

  logger
    .withScope("Auth")
    .warn(
      `Failed login attempt for username='${username}' from ip='${clientIp}' (${reasonLabel}); attempts=${result.failures}/${loginAttemptLimit}, remaining_before_lockout=${result.attemptsRemaining}.`,
    );
}

export async function login(
  _previousState: { errorKey?: string } | undefined,
  formData: FormData,
) {
  const username = formData.get("username");
  const password = formData.get("password");
  const next = formData.get("next");
  const usernameValue = typeof username === "string" ? username.trim() : "";
  const { rateLimitKey, clientIp } =
    await getLoginRequestContext(usernameValue);
  const now = Date.now();

  const expiredLockout = clearExpiredLockout(rateLimitKey, now);
  if (expiredLockout.wasCleared) {
    logger
      .withScope("Auth")
      .info(
        `Lockout expired for username='${usernameValue || "unknown"}' from ip='${clientIp}'. Access unblocked after ${expiredLockout.failures} failed attempt(s).`,
      );
  }

  pruneFailedLoginState(now);

  if (isRateLimited(rateLimitKey, now)) {
    const remainingSeconds = getLockoutRemainingSeconds(rateLimitKey, now);
    logger
      .withScope("Auth")
      .warn(
        `Blocked login attempt for username='${usernameValue || "unknown"}' from ip='${clientIp}' due to active lockout (${remainingSeconds}s remaining).`,
      );
    return { errorKey: "error_too_many_attempts" };
  }

  // Security: Validate input types and presence
  if (
    typeof username !== "string" ||
    !usernameValue ||
    typeof password !== "string" ||
    !password
  ) {
    const failedAttempt = registerFailedAttempt(rateLimitKey, now);
    logFailedLoginAttempt(
      typeof username === "string" ? usernameValue : "unknown",
      clientIp,
      "invalid_input",
      failedAttempt,
    );
    return { errorKey: "error_invalid_credentials" };
  }

  if (
    username === process.env.AUTH_USERNAME &&
    password === process.env.AUTH_PASSWORD
  ) {
    const previousFailures =
      failedLoginAttempts.get(rateLimitKey)?.failures ?? 0;
    clearFailedAttempts(rateLimitKey);
    const session = await getSession();
    session.isLoggedIn = true;
    session.username = username;
    await session.save();
    logger
      .withScope("Auth")
      .info(
        `Successful login for username='${username}' from ip='${clientIp}'`,
      );
    if (previousFailures > 0) {
      logger
        .withScope("Auth")
        .info(
          `Cleared ${previousFailures} failed login attempt(s) for username='${username}' from ip='${clientIp}' after successful authentication.`,
        );
    }

    // Revalidate the root path to ensure data is fresh after login.
    // The path revalidated must be the absolute path, not the translated one.
    revalidatePath("/", "layout");

    // Security: Only redirect to relative paths within the app to prevent open redirect vulnerabilities.
    if (
      typeof next === "string" &&
      next.startsWith("/") &&
      !next.startsWith("//") &&
      !next.includes("..")
    ) {
      const locale = await getLocale();
      // Remove the leading locale from the 'next' parameter before redirecting
      // e.g., transforms "/de/test" to "/test"
      const pathWithoutLocale = next.startsWith(`/${locale}`)
        ? next.substring(`/${locale}`.length)
        : next;

      // Ensure the path is not empty and starts with a slash
      const finalPath =
        (pathWithoutLocale.startsWith("/")
          ? pathWithoutLocale
          : `/${pathWithoutLocale}`) || "/";

      logger
        .withScope("Auth")
        .info(`Redirect after login to '${finalPath}' (locale=${locale})`);
      await redirectLocalized(finalPath, locale);
    } else {
      const locale = await getLocale();
      logger
        .withScope("Auth")
        .info(`Redirect after login to '/' (locale=${locale})`);
      await redirectLocalized("/", locale);
    }
  }

  const failedAttempt = registerFailedAttempt(rateLimitKey, now);
  logFailedLoginAttempt(
    usernameValue || "unknown",
    clientIp,
    "invalid_credentials",
    failedAttempt,
  );
  return {
    errorKey: failedAttempt.lockoutTriggered
      ? "error_too_many_attempts"
      : "error_invalid_credentials",
  };
}

export async function logout() {
  const session = await getSession();
  const locale = await getLocale();
  const user = session.username || "unknown";
  logger.withScope("Auth").info(`User '${user}' logged out`);
  session.destroy();

  const loginPath = pathnames["/login"][locale as "en" | "de"];
  revalidatePath("/");
  await redirectLocalized(loginPath, locale);
}
