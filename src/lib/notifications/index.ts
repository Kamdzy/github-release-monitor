import { logger } from "@/lib/logger";
import {
  sendAppriseNotification,
  sendTestAppriseNotification,
} from "@/lib/notifications/apprise";
import { getNotificationRuntimeConfig } from "@/lib/notifications/config";
import {
  sendNewReleaseEmail,
  sendPackageUpdateEmail,
} from "@/lib/notifications/email";
import type {
  AppriseFormat,
  AppSettings,
  GithubRelease,
  Locale,
  NotificationChannel,
  NotificationSettings,
  Repository,
  TagDigest,
} from "@/types";

export { sendTestAppriseNotification };

export class NotificationDeliveryError extends Error {
  constructor(
    readonly failedChannels: NotificationChannel[],
    options?: ErrorOptions,
  ) {
    super("One or more notification services failed to send.", options);
    this.name = "NotificationDeliveryError";
  }
}

export function getConfiguredNotificationChannels(): NotificationChannel[] {
  const { isSmtpConfigured, isAppriseConfigured } =
    getNotificationRuntimeConfig();
  const channels: NotificationChannel[] = [];
  if (isSmtpConfigured) channels.push("email");
  if (isAppriseConfigured) channels.push("apprise");
  return channels;
}

export async function sendNotification(
  repository: Repository,
  release: GithubRelease,
  locale: Locale,
  settings: NotificationSettings,
  requestedChannels = getConfiguredNotificationChannels(),
) {
  const { isAppriseConfigured } = getNotificationRuntimeConfig();
  const notifications: Array<{
    channel: NotificationChannel;
    promise: Promise<void>;
  }> = [];

  if (requestedChannels.includes("email")) {
    notifications.push({
      channel: "email",
      promise: sendNewReleaseEmail(
        repository,
        release,
        locale,
        settings.timeFormat,
        undefined,
        settings.emailIncludeReleaseNotes !== false,
      ),
    });
  }

  if (requestedChannels.includes("apprise")) {
    notifications.push({
      channel: "apprise",
      promise: isAppriseConfigured
        ? sendAppriseNotification(repository, release, locale, settings)
        : Promise.reject(new Error("Apprise is no longer configured.")),
    });
  }

  if (notifications.length === 0) {
    logger
      .withScope("Notifications")
      .warn(
        `No notification services (SMTP or Apprise) are configured. Skipping notification for ${repository.id}.`,
      );
    return;
  }

  const results = await Promise.allSettled(
    notifications.map(({ promise }) => promise),
  );
  const failedChannels = results.flatMap((result, index) =>
    result.status === "rejected" ? [notifications[index].channel] : [],
  );
  if (failedChannels.length > 0) {
    throw new NotificationDeliveryError(failedChannels, {
      cause: new AggregateError(
        results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        ),
      ),
    });
  }
}

// Generates the plain text body for a package digest change notification.
function generatePackageNotificationText(
  repo: Repository,
  changedTags: TagDigest[],
): string {
  const lines: string[] = [
    `GHCR Package Update: ${repo.packageOwner}/${repo.packageName}`,
    "",
  ];
  for (const tag of changedTags) {
    const shortDigest = tag.digest.startsWith("sha256:")
      ? tag.digest.slice(0, 19)
      : tag.digest.slice(0, 12);
    lines.push(`Tag "${tag.tag}" → ${shortDigest}`);
    lines.push(`  Updated: ${tag.lastUpdated}`);
  }
  lines.push("");
  lines.push(`View: ${repo.url}`);
  return lines.join("\n");
}

// Generates the markdown body for a package digest change notification.
function generatePackageNotificationMarkdown(
  repo: Repository,
  changedTags: TagDigest[],
): string {
  const lines: string[] = [
    `## GHCR Package Update: ${repo.packageOwner}/${repo.packageName}`,
    "",
  ];
  for (const tag of changedTags) {
    const shortDigest = tag.digest.startsWith("sha256:")
      ? tag.digest.slice(0, 19)
      : tag.digest.slice(0, 12);
    lines.push(
      `- **${tag.tag}**: \`${shortDigest}\` (updated ${tag.lastUpdated})`,
    );
  }
  lines.push("");
  lines.push(`[View on GitHub](${repo.url})`);
  return lines.join("\n");
}

// Sends notifications for GHCR package digest changes via all configured channels.
export async function sendPackageNotification(
  repo: Repository,
  changedTags: TagDigest[],
  locale: Locale,
  settings: AppSettings,
): Promise<void> {
  const log = logger.withScope("PackageNotifications");
  const { MAIL_HOST, APPRISE_URL } = process.env;

  const promises: Promise<void>[] = [];

  if (MAIL_HOST) {
    promises.push(
      sendPackageUpdateEmail(repo, changedTags, locale, settings.timeFormat),
    );
  }

  if (APPRISE_URL) {
    const format: AppriseFormat =
      repo.appriseFormat ?? settings.appriseFormat ?? "text";

    let body: string;
    if (format === "markdown") {
      body = generatePackageNotificationMarkdown(repo, changedTags);
    } else {
      body = generatePackageNotificationText(repo, changedTags);
    }

    const title = `GHCR Update: ${repo.packageOwner}/${repo.packageName}`;
    const tags = repo.appriseTags ?? settings.appriseTags;

    const normalizedAppriseUrl = APPRISE_URL.replace(/\/+$/, "");
    const notifyUrl = /\/notify(\/|$)/.test(normalizedAppriseUrl)
      ? normalizedAppriseUrl
      : `${normalizedAppriseUrl}/notify`;

    const payload: Record<string, string> = {
      title,
      body,
      format,
    };
    if (tags) payload.tag = tags;

    promises.push(
      fetch(notifyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).then((r) => {
        if (!r.ok) {
          throw new Error(`Apprise returned ${r.status}`);
        }
        log.info(
          `Apprise notification sent successfully for package ${repo.packageOwner}/${repo.packageName}`,
        );
      }),
    );
  }

  if (promises.length === 0) {
    log.warn("No notification services configured for package update.");
    return;
  }

  const results = await Promise.allSettled(promises);
  const failures = results.filter((r) => r.status === "rejected");
  if (failures.length > 0) {
    const reasons = failures
      .map((f) => (f as PromiseRejectedResult).reason)
      .join("; ");
    throw new Error(`Package notification(s) failed: ${reasons}`);
  }
}
