"use server";

import { logger } from "@/lib/logger";
import type {
  AppriseFormat,
  AppSettings,
  GithubRelease,
  Repository,
  TagDigest,
} from "@/types";
import { getTranslations } from "next-intl/server";
import {
  generateHtmlReleaseBody,
  generatePlainTextReleaseBody,
  getFormattedDate,
  sendNewReleaseEmail,
  sendPackageUpdateEmail,
} from "./email";

async function generateMarkdownReleaseBody(
  release: GithubRelease,
  repository: Repository,
  locale: string,
  settings: AppSettings,
  maxChars: number,
): Promise<string> {
  const t = await getTranslations({ locale, namespace: "Email" });
  const tApprise = await getTranslations({ locale, namespace: "Apprise" });
  const { htmlDate } = await getFormattedDate(
    new Date(release.created_at),
    locale,
    settings.timeFormat,
  );

  const viewOnGithubText = tApprise("view_on_github_link", {
    link: release.html_url,
  });
  const truncatedText = tApprise("truncated_message");
  const footerSeparator = "\n\n---\n\n";

  const title = tApprise("title", {
    repoId: repository.id,
    tagName: release.tag_name,
  });
  const repoLink = `**[${repository.id}](${repository.url})**`;
  const introText = t("text_new_version_of_markdown").replace(
    "REPO_PLACEHOLDER",
    repoLink,
  );

  const header = `
## ${title}

${introText}

* **${t("text_version_label")}**: ${release.tag_name}
* **${t("text_release_name_label")}**: ${release.name || "N/A"}
* **${t("text_release_date_label")}**: ${htmlDate}
`;

  let body = `${header.trim()}\n\n### ${t("text_release_notes_label")}\n---\n${release.body || t("text_no_notes")}`;

  if (maxChars > 0) {
    const footer = `${footerSeparator}${truncatedText}\n${viewOnGithubText}`;
    const availableLength = maxChars - footer.length;

    if (body.length > availableLength) {
      if (availableLength > 0) {
        body = body.substring(0, availableLength) + footer;
      } else {
        body = viewOnGithubText;
      }
    } else {
      body = `${body}${footerSeparator}${viewOnGithubText}`;
    }
  } else {
    body = `${body}${footerSeparator}${viewOnGithubText}`;
  }
  return body;
}

async function generateAppriseBody(
  release: GithubRelease,
  repository: Repository,
  format: AppriseFormat,
  locale: string,
  settings: AppSettings,
): Promise<string> {
  const maxChars = settings.appriseMaxCharacters ?? 0;
  const tApprise = await getTranslations({ locale, namespace: "Apprise" });

  switch (format) {
    case "html":
      return generateHtmlReleaseBody(
        release,
        repository,
        locale,
        settings.timeFormat,
      );
    case "markdown":
      return generateMarkdownReleaseBody(
        release,
        repository,
        locale,
        settings,
        maxChars,
      );
    default: {
      // Treat "text" and any unexpected formats as plain text notifications.
      const title = tApprise("title", {
        repoId: repository.id,
        tagName: release.tag_name,
      });
      const plainTextBody = await generatePlainTextReleaseBody(
        release,
        repository,
        locale,
        settings.timeFormat,
      );
      const fullBody = `${title}\n\n${plainTextBody.trim()}`;

      if (maxChars > 0 && fullBody.length > maxChars) {
        return fullBody.substring(0, maxChars);
      }
      return fullBody;
    }
  }
}

async function sendAppriseNotification(
  repository: Repository,
  release: GithubRelease,
  locale: string,
  settings: AppSettings,
) {
  const { APPRISE_URL } = process.env;
  if (!APPRISE_URL) return;

  const t = await getTranslations({ locale, namespace: "Apprise" });

  // Determine which settings to use
  const tags = repository.appriseTags ?? settings.appriseTags;
  // Default to 'text' if no format is specified anywhere
  const format = repository.appriseFormat ?? settings.appriseFormat ?? "text";

  const title = t("title", {
    repoId: repository.id,
    tagName: release.tag_name,
  });
  const body = await generateAppriseBody(
    release,
    repository,
    format,
    locale,
    settings,
  );

  const payload: {
    title: string;
    body: string;
    format: AppriseFormat;
    tag?: string;
  } = {
    title: title,
    body: body,
    format: format,
  };

  if (tags) {
    payload.tag = tags;
  }

  try {
    const normalizedAppriseUrl = APPRISE_URL.replace(/\/+$/, "");
    const notifyUrl = /\/notify(\/|$)/.test(normalizedAppriseUrl)
      ? normalizedAppriseUrl
      : `${normalizedAppriseUrl}/notify`;

    const response = await fetch(notifyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      logger
        .withScope("Notifications")
        .error(
          `Apprise notification for ${repository.id} failed with status ${response.status}: ${errorBody}`,
        );
      throw new Error(
        t("error_send_failed_detailed", {
          status: response.status,
          details: errorBody,
        }),
      );
    } else {
      logger
        .withScope("Notifications")
        .info(
          `Apprise notification sent successfully for ${repository.id} ${release.tag_name}`,
        );
    }
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : String(error ?? "unknown");
    logger
      .withScope("Notifications")
      .error(
        `Failed to send Apprise notification for ${repository.id}. Please check if the service is running and the URL is correct. Error: ${message}`,
        error instanceof Error ? error : undefined,
      );
    throw error instanceof Error ? error : new Error(message);
  }
}

export async function sendNotification(
  repository: Repository,
  release: GithubRelease,
  locale: string,
  settings: AppSettings,
) {
  const { MAIL_HOST, APPRISE_URL } = process.env;
  const notificationPromises = [];

  // Check and send SMTP email
  if (MAIL_HOST) {
    notificationPromises.push(
      sendNewReleaseEmail(repository, release, locale, settings.timeFormat),
    );
  }

  // Check and send Apprise notification
  if (APPRISE_URL) {
    notificationPromises.push(
      sendAppriseNotification(repository, release, locale, settings),
    );
  }

  if (notificationPromises.length === 0) {
    logger
      .withScope("Notifications")
      .warn(
        `No notification services (SMTP or Apprise) are configured. Skipping notification for ${repository.id}.`,
      );
    return;
  }

  // Execute all configured notification services
  const results = await Promise.allSettled(notificationPromises);

  // Check if any of the promises failed and re-throw an error if so.
  // This ensures that the calling function knows that a notification failed.
  const failed = results.find((result) => result.status === "rejected");
  if (failed) {
    // We log the specific reason in the respective functions.
    // Here, we just throw a generic error to signal failure.
    throw new Error("One or more notification services failed to send.");
  }
}

export async function sendTestAppriseNotification(
  repository: Repository,
  release: GithubRelease,
  locale: string,
  settings: AppSettings,
) {
  const t = await getTranslations({ locale, namespace: "Apprise" });
  const { APPRISE_URL } = process.env;
  if (!APPRISE_URL) {
    throw new Error(t("error_not_configured"));
  }
  // For testing, we force text to ensure maximum compatibility.
  const testSettings = { ...settings, appriseFormat: "text" as AppriseFormat };
  const testRepo = { ...repository, appriseFormat: "text" as AppriseFormat };
  await sendAppriseNotification(testRepo, release, locale, testSettings);
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
  locale: string,
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
