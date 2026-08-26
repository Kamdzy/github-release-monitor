import { revalidatePath } from "next/cache";
import { getLatestDigestsForPackages } from "@/lib/packages/package-actions";
import { isValidItemId } from "@/lib/packages/validation";
import { getLatestReleasesForRepos } from "@/lib/releases";
import { resolveEffectiveRepoFilters } from "@/lib/releases/filters";
import { applyReleaseFetchResultToRepository } from "@/lib/repositories/release-cache-update";
import { scheduleTask } from "@/lib/runtime/task-scheduler";
import { isRestrictedActionAllowed, log } from "@/lib/server-action-helpers";
import { setJobStatus } from "@/lib/storage/jobs";
import { getRepositories, saveRepositories } from "@/lib/storage/repositories";
import { getSettings } from "@/lib/storage/settings";
import type { AppSettings, Repository } from "@/types";

function createReleaseFetchFingerprint(
  repository: Repository,
  settings: AppSettings,
): string {
  const filters = resolveEffectiveRepoFilters(repository, settings);
  return JSON.stringify({
    url: repository.url,
    locale: settings.locale,
    releaseChannels: [...filters.effectiveReleaseChannels].sort(),
    preReleaseSubChannels: [...filters.effectivePreReleaseSubChannels].sort(),
    customPreReleaseMarkers: [
      ...filters.effectiveCustomPreReleaseMarkers,
    ].sort(),
    releaseSelectionStrategy: filters.effectiveReleaseSelectionStrategy,
    versionTagPattern: filters.versionTagPattern,
    releasesPerPage: filters.totalReleasesToFetch,
    includeRegex: filters.effectiveIncludeRegex,
    excludeRegex: filters.effectiveExcludeRegex,
    etag: repository.etag,
    latestRelease: repository.latestRelease,
  });
}

export async function refreshSingleRepositoryAction(repoId: string) {
  const snapshot = await scheduleTask(
    `refreshSingleRepositoryAction: ${repoId}`,
    async () => {
      if (!(await isRestrictedActionAllowed())) {
        return;
      }

      if (!isValidItemId(repoId)) {
        log.error("Invalid repoId format for refresh:", repoId);
        return;
      }

      log.info(`Refreshing single repository: ${repoId}`);

      const settings = await getSettings();
      const allRepos = await getRepositories();
      const repository = allRepos.find((repo) => repo.id === repoId);

      if (!repository) {
        log.error(`Repository ${repoId} not found for refresh.`);
        return;
      }

      return {
        repository,
        settings,
        fingerprint:
          repository.type === "package"
            ? null
            : createReleaseFetchFingerprint(repository, settings),
      };
    },
  );

  if (!snapshot) return;

  // Package (GHCR) refresh path — bypass release fingerprint/fetch entirely.
  if (snapshot.repository.type === "package") {
    const enrichedPackages = await getLatestDigestsForPackages(
      [snapshot.repository],
      snapshot.settings,
    );
    const enriched = enrichedPackages[0];
    if (!enriched) {
      log.error(`Failed to get digests for ${repoId} during single refresh.`);
      return;
    }
    return scheduleTask(`commitRefreshSinglePackage: ${repoId}`, async () => {
      const allRepos = await getRepositories();
      const repoIndex = allRepos.findIndex((repo) => repo.id === repoId);
      if (repoIndex === -1) return;
      if (enriched.tagChanges) {
        allRepos[repoIndex].tagDigests = enriched.tagChanges;
      }
      await saveRepositories(allRepos);
      revalidatePath("/");
    });
  }

  const releaseFingerprint = snapshot.fingerprint;
  if (releaseFingerprint === null) return;

  const enrichedReleases = await getLatestReleasesForRepos(
    [snapshot.repository],
    snapshot.settings,
    snapshot.settings.locale,
    { skipCache: true },
  );
  const enrichedRelease = enrichedReleases[0];
  if (!enrichedRelease) {
    log.error(`Failed to get release for ${repoId} during single refresh.`);
    return;
  }

  return scheduleTask(`commitRefreshSingleRepository: ${repoId}`, async () => {
    const [allRepos, currentSettings] = await Promise.all([
      getRepositories(),
      getSettings(),
    ]);
    const repoIndex = allRepos.findIndex((repo) => repo.id === repoId);
    if (repoIndex === -1) return;

    if (
      releaseFingerprint !==
      createReleaseFetchFingerprint(allRepos[repoIndex], currentSettings)
    ) {
      log.info(
        `Skipped stale single refresh result for ${repoId} because its effective fetch inputs changed.`,
      );
      return;
    }

    applyReleaseFetchResultToRepository(allRepos[repoIndex], enrichedRelease, {
      initializeLastSeenFromFetchedRelease: true,
    });

    await saveRepositories(allRepos);
    revalidatePath("/");
  });
}

export async function refreshMultipleRepositoriesAction(
  repoIds: string[],
  jobId: string,
) {
  try {
    log.info(
      `Refresh multiple repositories start: count=${repoIds.length} jobId=${jobId}`,
    );
    const settings = await getSettings();
    const locale = settings.locale;
    const allRepos = await getRepositories();
    const reposToRefresh = allRepos.filter((r) => repoIds.includes(r.id));
    const releaseReposToRefresh = reposToRefresh.filter(
      (r) => r.type !== "package",
    );
    const packageReposToRefresh = reposToRefresh.filter(
      (r) => r.type === "package",
    );

    if (reposToRefresh.length > 0) {
      const fetchFingerprints = new Map(
        releaseReposToRefresh.map((repository) => [
          repository.id,
          createReleaseFetchFingerprint(repository, settings),
        ]),
      );
      const [enrichedReleases, enrichedPackages] = await Promise.all([
        releaseReposToRefresh.length > 0
          ? getLatestReleasesForRepos(releaseReposToRefresh, settings, locale, {
              skipCache: true,
            })
          : Promise.resolve([]),
        packageReposToRefresh.length > 0
          ? getLatestDigestsForPackages(packageReposToRefresh, settings)
          : Promise.resolve([]),
      ]);

      const enrichedMap = new Map(enrichedReleases.map((r) => [r.repoId, r]));
      const enrichedPackageMap = new Map(
        enrichedPackages.map((p) => [p.repoId, p]),
      );
      await scheduleTask(
        `commitRefreshMultipleRepositories: ${jobId}`,
        async () => {
          // Re-read after the network phase so concurrent deletes, imports, and
          // unrelated settings changes are preserved. Results whose effective
          // fetch inputs changed are left for the next refresh.
          const currentRepos = await getRepositories();
          const currentSettings = await getSettings();
          for (const repo of currentRepos) {
            if (repo.type === "package") {
              const enrichedPkg = enrichedPackageMap.get(repo.id);
              if (enrichedPkg?.tagChanges) {
                repo.tagDigests = enrichedPkg.tagChanges;
              }
              continue;
            }
            const enriched = enrichedMap.get(repo.id);
            const fetchFingerprint = fetchFingerprints.get(repo.id);
            if (
              enriched &&
              fetchFingerprint ===
                createReleaseFetchFingerprint(repo, currentSettings)
            ) {
              applyReleaseFetchResultToRepository(repo, enriched, {
                initializeLastSeenFromFetchedRelease: true,
              });
            } else if (enriched && fetchFingerprint) {
              log.info(
                `Skipped stale background refresh result for ${repo.id} because its effective fetch inputs changed.`,
              );
            }
          }
          await saveRepositories(currentRepos);
        },
      );
    }
    setJobStatus(jobId, "complete");
    log.info(`Refresh multiple repositories complete: jobId=${jobId}`);
  } catch (error) {
    log.error(`[Job ${jobId}] Failed to refresh repositories:`, error);
    setJobStatus(jobId, "error");
  }
}
