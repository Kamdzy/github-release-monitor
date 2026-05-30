"use server";

import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { logger } from "@/lib/logger";
import { sendPackageNotification } from "@/lib/notifications";
import {
  isValidItemId,
  parseGhcrPackageUrl,
} from "@/lib/packages/validation";
import { fetchJsonResponseWithRetry } from "@/lib/releases/fetch";
import { resolveParallelRepoFetches } from "@/lib/releases/filters";
import { refreshMultipleRepositoriesAction } from "@/lib/repositories/repository-actions-service";
import { log } from "@/lib/server-action-helpers";
import { getJobStatus, setJobStatus } from "@/lib/storage/jobs";
import { getRepositories, saveRepositories } from "@/lib/storage/repositories";
import { getSettings } from "@/lib/storage/settings";
import { scheduleTask } from "@/lib/runtime/task-scheduler";
import type {
  AppriseFormat,
  AppSettings,
  EnrichedRelease,
  FetchError,
  Repository,
  TagDigest,
} from "@/types";

// ─── GHCR Package URL Parsing ─────────────────────────────────────────────────

// GitHub Packages API response shape for a container version.
type GhcrPackageVersion = {
  id: number;
  name: string; // sha256 digest
  created_at: string;
  updated_at: string;
  html_url?: string;
  metadata?: {
    package_type?: string;
    container?: {
      tags?: string[];
    };
  };
};

// ─── GHCR Package Version Fetching ───────────────────────────────────────────

// Fetches the current digest for each monitored tag from the GitHub Packages API.
async function fetchPackageVersions(
  owner: string,
  packageName: string,
  ownerType: "users" | "orgs",
  monitoredTags: string[],
): Promise<{
  tagDigests: TagDigest[];
  error: FetchError | null;
}> {
  if (monitoredTags.length === 0) {
    return { tagDigests: [], error: null };
  }

  const headers: HeadersInit = {
    Accept: "application/vnd.github+json",
    "User-Agent": "GitHubReleaseMonitorApp",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (process.env.GITHUB_ACCESS_TOKEN) {
    headers.Authorization = `token ${process.env.GITHUB_ACCESS_TOKEN}`;
  }

  const tagSet = new Set(monitoredTags);
  const foundDigests = new Map<string, TagDigest>();
  const PER_PAGE = 100;
  const MAX_PAGES = 10; // safety limit

  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const apiUrl = `https://api.github.com/${ownerType}/${owner}/packages/container/${packageName}/versions?per_page=${PER_PAGE}&page=${page}&state=active`;
      const { response, data } = await fetchJsonResponseWithRetry<
        GhcrPackageVersion[]
      >(
        apiUrl,
        { headers, cache: "no-store" },
        {
          description: `GHCR versions for ${owner}/${packageName} (page ${page})`,
        },
      );

      if (!response.ok) {
        if (response.status === 404) {
          return { tagDigests: [], error: { type: "package_not_found" } };
        }
        if (response.status === 403 || response.status === 429) {
          return { tagDigests: [], error: { type: "rate_limit" } };
        }
        return { tagDigests: [], error: { type: "api_error" } };
      }

      if (!data || !Array.isArray(data)) {
        return { tagDigests: [], error: { type: "api_error" } };
      }

      for (const version of data) {
        const versionTags = version.metadata?.container?.tags ?? [];
        for (const vTag of versionTags) {
          if (tagSet.has(vTag) && !foundDigests.has(vTag)) {
            foundDigests.set(vTag, {
              tag: vTag,
              digest: version.name,
              lastUpdated: version.updated_at,
            });
          }
        }
      }

      // Stop early if all monitored tags are found or if we got fewer results than a full page
      if (foundDigests.size >= tagSet.size || data.length < PER_PAGE) {
        break;
      }
    }

    return { tagDigests: Array.from(foundDigests.values()), error: null };
  } catch (error) {
    log.error(
      `Error fetching GHCR versions for ${owner}/${packageName}:`,
      error,
    );
    return { tagDigests: [], error: { type: "api_error" } };
  }
}

// Batch-fetches digests for multiple packages, returning EnrichedRelease[] for the grid.
export async function getLatestDigestsForPackages(
  packages: Repository[],
  settings: AppSettings,
): Promise<EnrichedRelease[]> {
  if (packages.length === 0) {
    return [];
  }

  const configuredParallel = resolveParallelRepoFetches(settings);
  const effectiveBatchSize = Math.min(configuredParallel, packages.length);

  log.info(
    `Fetching digests for ${packages.length} packages with batch size ${effectiveBatchSize}.`,
  );

  const buildEnrichedPackage = async (
    pkg: Repository,
  ): Promise<EnrichedRelease> => {
    if (!pkg.packageOwner || !pkg.packageName || !pkg.monitoredTags?.length) {
      return {
        repoId: pkg.id,
        repoUrl: pkg.url,
        error: { type: "invalid_url" },
        isNew: pkg.isNew,
      };
    }

    const { tagDigests, error } = await fetchPackageVersions(
      pkg.packageOwner,
      pkg.packageName,
      pkg.packageOwnerType ?? "users",
      pkg.monitoredTags,
    );

    if (error) {
      return {
        repoId: pkg.id,
        repoUrl: pkg.url,
        error,
        isNew: pkg.isNew,
        packageInfo: {
          owner: pkg.packageOwner,
          name: pkg.packageName,
          ownerType: pkg.packageOwnerType ?? "users",
          monitoredTags: pkg.monitoredTags,
          tagDigests: pkg.tagDigests ?? [],
          latestTagChange: pkg.latestTagChange,
        },
      };
    }

    return {
      repoId: pkg.id,
      repoUrl: pkg.url,
      isNew: pkg.isNew,
      tagChanges: tagDigests,
      packageInfo: {
        owner: pkg.packageOwner,
        name: pkg.packageName,
        ownerType: pkg.packageOwnerType ?? "users",
        monitoredTags: pkg.monitoredTags,
        tagDigests,
        latestTagChange: pkg.latestTagChange,
      },
    };
  };

  const results: EnrichedRelease[] = new Array(packages.length);

  for (let start = 0; start < packages.length; start += effectiveBatchSize) {
    const batch = packages.slice(start, start + effectiveBatchSize);
    await Promise.all(
      batch.map(async (pkg, offset) => {
        const result = await buildEnrichedPackage(pkg);
        results[start + offset] = result;
      }),
    );
  }

  return results;
}

// ─── Server Actions ──────────────────────────────────────────────────────────

// Adds GHCR container packages for monitoring.
export async function addPackagesAction(
  _prevState: unknown,
  formData: FormData,
): Promise<{
  success: boolean;
  toast?: { title: string; description: string };
  error?: string;
  jobId?: string;
}> {
  const t = await getTranslations("PackageForm");
  const urlsRaw = (formData.get("urls") as string | null) ?? "";
  const tagsRaw = (formData.get("tags") as string | null) ?? "";

  const monitoredTags = tagsRaw
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);

  if (monitoredTags.length === 0) {
    return { success: false, error: t("toast_no_tags") };
  }

  return scheduleTask("addPackagesAction", async () => {
    const lines = urlsRaw
      .split(/[\n,]+/)
      .map((l) => l.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      return { success: false, error: t("toast_no_urls") };
    }

    const existingRepos = await getRepositories();
    const existingIds = new Set(existingRepos.map((r) => r.id));
    const newPackages: Repository[] = [];
    let skippedCount = 0;
    let failedCount = 0;

    for (const line of lines) {
      const parsed = parseGhcrPackageUrl(line);
      if (!parsed) {
        failedCount++;
        continue;
      }
      if (existingIds.has(parsed.id)) {
        skippedCount++;
        continue;
      }
      existingIds.add(parsed.id);
      newPackages.push({
        id: parsed.id,
        url: `https://github.com/${parsed.owner}/${parsed.packageName}/pkgs/container/${parsed.packageName}`,
        type: "package",
        packageOwner: parsed.owner,
        packageName: parsed.packageName,
        packageOwnerType: parsed.ownerType,
        monitoredTags,
      });
    }

    if (newPackages.length === 0) {
      if (failedCount > 0) {
        return {
          success: false,
          error: t("toast_fail_description", { failed: failedCount }),
        };
      }
      return {
        success: true,
        toast: {
          title: t("toast_success_title"),
          description: t("toast_all_skipped"),
        },
      };
    }

    const allRepos = [...existingRepos, ...newPackages];
    await saveRepositories(allRepos);

    const jobId = crypto.randomUUID();
    setJobStatus(jobId, "pending");

    const newIds = newPackages.map((p) => p.id);
    // Fire and forget the background refresh
    scheduleTask(`refreshPackages: ${jobId}`, async () => {
      try {
        await refreshMultipleRepositoriesAction(newIds, jobId);
      } catch (error) {
        log.error("Failed to refresh newly added packages:", error);
        setJobStatus(jobId, "error");
      }
    });

    revalidatePath("/");
    return {
      success: true,
      toast: {
        title: t("toast_success_title"),
        description: t("toast_success_description", {
          added: newPackages.length,
          skipped: skippedCount,
          failed: failedCount,
        }),
      },
      jobId,
    };
  });
}

// Updates settings for a monitored GHCR package.
export async function updatePackageSettingsAction(
  repoId: string,
  settings: {
    monitoredTags?: string[];
    appriseTags?: string;
    appriseFormat?: AppriseFormat;
  },
): Promise<{ success: boolean; error?: string }> {
  return scheduleTask(`updatePackageSettingsAction: ${repoId}`, async () => {
    if (!isValidItemId(repoId)) {
      return { success: false, error: "Invalid package ID." };
    }

    const allRepos = await getRepositories();
    const repoIndex = allRepos.findIndex((r) => r.id === repoId);
    if (repoIndex === -1) {
      return { success: false, error: "Package not found." };
    }

    const repo = allRepos[repoIndex];
    if (repo.type !== "package") {
      return { success: false, error: "Item is not a package." };
    }

    if (settings.monitoredTags !== undefined) {
      const tags = settings.monitoredTags
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
      if (tags.length === 0) {
        return { success: false, error: "At least one tag must be monitored." };
      }
      repo.monitoredTags = tags;
    }
    if (settings.appriseTags !== undefined) {
      repo.appriseTags = settings.appriseTags || undefined;
    }
    if (settings.appriseFormat !== undefined) {
      repo.appriseFormat = settings.appriseFormat || undefined;
    }

    allRepos[repoIndex] = repo;
    await saveRepositories(allRepos);
    revalidatePath("/");
    return { success: true };
  });
}

// Primes sentinel digests for a real monitored package, then runs the package
// change-detection path end-to-end. Used to verify notifications are wired up
// correctly for a specific package's configuration without waiting for GHCR.
export async function simulatePackageUpdateAction(
  repoId: string,
): Promise<{ success: boolean; notificationSent?: boolean; error?: string }> {
  return scheduleTask(`simulatePackageUpdateAction: ${repoId}`, async () => {
    if (!isValidItemId(repoId)) {
      return { success: false, error: "Invalid package id." };
    }

    const settings = await getSettings();
    const locale = settings.locale;
    const allRepos = await getRepositories();
    const repoIndex = allRepos.findIndex((r) => r.id === repoId);
    if (repoIndex === -1) {
      return { success: false, error: "Package not found." };
    }

    const repo = allRepos[repoIndex];
    if (
      repo.type !== "package" ||
      !repo.tagDigests ||
      repo.tagDigests.length === 0
    ) {
      return {
        success: false,
        error: "Package has no stored digests yet. Refresh first, then retry.",
      };
    }

    const sentinel = `sha256:simulated_${Date.now().toString(16)}`;
    repo.tagDigests = repo.tagDigests.map((td) => ({
      ...td,
      digest: sentinel,
    }));
    await saveRepositories(allRepos);

    try {
      const [enriched] = await getLatestDigestsForPackages([repo], settings);
      if (!enriched) {
        return { success: false, error: "Fetch returned no result." };
      }

      const { changed, notificationSent } = await processPackageChange(
        enriched,
        repo,
        settings,
        locale,
      );

      if (changed) {
        allRepos[repoIndex] = repo;
        await saveRepositories(allRepos);
      }

      revalidatePath("/");
      return { success: true, notificationSent };
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error ?? "unknown");
      log.error(`Simulate update failed for ${repoId}: ${message}`);
      return { success: false, error: message };
    }
  });
}

// ─── Package Change Detection ────────────────────────────────────────────────

// Processes a single package fetch result: updates digests, detects changes,
// and dispatches notifications. Mutates `repo` in place. Extracted so both
// the full check loop and the manual simulate action share the same behavior.
export async function processPackageChange(
  enrichedPkg: EnrichedRelease,
  repo: Repository,
  settings: AppSettings,
  effectiveLocale: string,
): Promise<{ changed: boolean; notificationSent: boolean }> {
  if (enrichedPkg.error) {
    log.warn(
      `Package fetch failed for ${repo.id}: error=${enrichedPkg.error.type}. Check that GITHUB_ACCESS_TOKEN has read:packages scope.`,
    );
    return { changed: false, notificationSent: false };
  }

  const newDigests = enrichedPkg.tagChanges ?? [];
  if (newDigests.length === 0) {
    return { changed: false, notificationSent: false };
  }

  const oldDigestMap = new Map(
    (repo.tagDigests ?? []).map((d) => [d.tag, d.digest]),
  );
  const isFirstFetch = !repo.tagDigests || repo.tagDigests.length === 0;
  const changedTags: TagDigest[] = [];

  for (const newDigest of newDigests) {
    const oldDigest = oldDigestMap.get(newDigest.tag);
    if (oldDigest && oldDigest !== newDigest.digest) {
      changedTags.push(newDigest);
    }
  }

  repo.tagDigests = newDigests;

  if (isFirstFetch) {
    const initial = newDigests
      .map((d) => `${d.tag}=${d.digest.slice(0, 19)}`)
      .join(", ");
    log.info(
      `First fetch for package ${repo.id}: recorded initial digests [${initial}]. No notification sent (baseline).`,
    );
    repo.isNew = false;
    return { changed: true, notificationSent: false };
  }

  if (changedTags.length === 0) {
    log.info(
      `Package ${repo.id} checked: no digest changes across ${newDigests.length} monitored tag(s).`,
    );
    return { changed: true, notificationSent: false };
  }

  const transitions = changedTags
    .map((t) => {
      const prev = oldDigestMap.get(t.tag) ?? "unknown";
      return `${t.tag}: ${prev.slice(0, 19)} -> ${t.digest.slice(0, 19)}`;
    })
    .join("; ");
  log.info(
    `Package digest change detected for ${repo.id} [${transitions}]. Dispatching notification...`,
  );

  const shouldHighlight = settings.showAcknowledge ?? true;
  repo.isNew = shouldHighlight;
  repo.latestTagChange = {
    tag: changedTags[0].tag,
    newDigest: changedTags[0].digest,
    previousDigest: oldDigestMap.get(changedTags[0].tag),
    detectedAt: new Date().toISOString(),
    packageUrl: repo.url,
  };

  try {
    await sendPackageNotification(repo, changedTags, effectiveLocale, settings);
    log.info(
      `Notification dispatched for package ${repo.id} (${changedTags.length} tag change(s)).`,
    );
    return { changed: true, notificationSent: true };
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : String(error ?? "unknown");
    log.error(
      `Failed to send notification for package ${repo.id}. Digests updated to prevent repeat. Error: ${message}`,
      error instanceof Error ? error : undefined,
    );
    return { changed: true, notificationSent: false };
  }
}
