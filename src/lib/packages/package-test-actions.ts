"use server";

import { sendPackageNotification } from "@/lib/notifications";
import { log } from "@/lib/server-action-helpers";
import { getSettings } from "@/lib/storage/settings";
import type { Repository, TagDigest } from "@/types";
import { getLocale, getTranslations } from "next-intl/server";

export async function sendTestApprisePackageAction(): Promise<{
  success: boolean;
  error?: string;
}> {
  const locale = await getLocale();
  const t = await getTranslations({ locale, namespace: "TestPage" });

  const { APPRISE_URL } = process.env;
  if (!APPRISE_URL) {
    log.warn(
      "sendTestApprisePackageAction called but APPRISE_URL is not configured",
    );
    return {
      success: false,
      error: t("toast_apprise_not_configured_error"),
    };
  }

  const testRepo: Repository = {
    id: "ghcr:test/test-package",
    url: "https://github.com/test/test-package/pkgs/container/test-package",
    type: "package",
    packageOwner: "test",
    packageName: "test-package",
    packageOwnerType: "users",
    monitoredTags: ["latest", "release"],
  };

  const testChangedTags: TagDigest[] = [
    {
      tag: "release",
      digest: "sha256:39e30bd8e664abcdef1234",
      lastUpdated: new Date().toISOString(),
    },
  ];

  try {
    const settings = await getSettings();
    await sendPackageNotification(testRepo, testChangedTags, locale, settings);
    return { success: true };
  } catch (error: unknown) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : String(error ?? "unknown"),
    };
  }
}
