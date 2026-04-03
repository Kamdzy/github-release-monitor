"use client";

import { formatDistanceToNowStrict } from "date-fns";
import { de } from "date-fns/locale";
import {
  AlertTriangle,
  BellPlus,
  Box,
  CheckSquare,
  ExternalLink,
  Loader2,
  Settings,
  Trash2,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import * as React from "react";

import {
  acknowledgeNewReleaseAction,
  markAsNewAction,
  removeRepositoryAction,
} from "@/app/actions";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useNetworkStatus } from "@/hooks/use-network";
import { useToast } from "@/hooks/use-toast";
import { reloadIfServerActionStale } from "@/lib/server-action-error";
import { cn } from "@/lib/utils";
import type { AppSettings, EnrichedRelease, FetchError } from "@/types";

import { PackageSettingsDialog } from "./package-settings-dialog";

/** Maps a FetchError to a user-facing translated message. */
function getErrorMessage(
  error: FetchError,
  t: (key: string) => string,
): string {
  switch (error.type) {
    case "rate_limit":
      return t("error_rate_limit");
    case "package_not_found":
      return t("error_package_not_found");
    case "invalid_url":
      return t("error_invalid_url");
    default:
      return t("error_generic_fetch");
  }
}

/** Truncate a container digest string to a short display form. */
function truncateDigest(digest: string, length = 12): string {
  // Digests are typically "sha256:abc123...". Show the prefix + truncated hash.
  const colonIdx = digest.indexOf(":");
  if (colonIdx !== -1) {
    const prefix = digest.slice(0, colonIdx + 1);
    const hash = digest.slice(colonIdx + 1);
    return `${prefix}${hash.slice(0, length)}`;
  }
  return digest.slice(0, length);
}

interface PackageCardProps {
  enrichedRelease: EnrichedRelease;
  settings: AppSettings;
}

export function PackageCard({ enrichedRelease, settings }: PackageCardProps) {
  const t = useTranslations("PackageCard");
  const tActions = useTranslations("Actions");
  const locale = useLocale();
  const { toast } = useToast();
  const { repoId, repoUrl, error, isNew, packageInfo, tagChanges } =
    enrichedRelease;
  const { isOnline } = useNetworkStatus();

  const [isRemoving, startRemoveTransition] = React.useTransition();
  const [isAcknowledging, startAcknowledgeTransition] = React.useTransition();
  const [isMarkingAsNew, startMarkingAsNewTransition] = React.useTransition();
  const [isSettingsOpen, setIsSettingsOpen] = React.useState(false);
  const settingsButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const prevIsSettingsOpenRef = React.useRef(false);

  // Build a set of tags that have changed for quick lookup.
  const changedTagSet = React.useMemo(() => {
    if (!tagChanges) return new Set<string>();
    return new Set(tagChanges.map((tc) => tc.tag));
  }, [tagChanges]);

  // Return focus to the settings trigger button when the dialog closes.
  React.useEffect(() => {
    if (prevIsSettingsOpenRef.current && !isSettingsOpen) {
      const btn = settingsButtonRef.current;
      setTimeout(() => btn?.focus(), 0);
    }
    prevIsSettingsOpenRef.current = isSettingsOpen;
  }, [isSettingsOpen]);

  // Periodically format the "last updated" times for each tag digest.
  const [formattedDigestTimes, setFormattedDigestTimes] = React.useState<
    Record<string, string>
  >({});

  React.useEffect(() => {
    if (!packageInfo?.tagDigests) return;

    const update = () => {
      const times: Record<string, string> = {};
      for (const td of packageInfo.tagDigests) {
        times[td.tag] = formatDistanceToNowStrict(new Date(td.lastUpdated), {
          addSuffix: true,
          locale: locale === "de" ? de : undefined,
        });
      }
      setFormattedDigestTimes(times);
    };

    update();
    const intervalId = setInterval(update, 60_000);
    return () => clearInterval(intervalId);
  }, [packageInfo?.tagDigests, locale]);

  const handleRemove = () => {
    startRemoveTransition(async () => {
      try {
        await removeRepositoryAction(repoId);
      } catch (err: unknown) {
        if (reloadIfServerActionStale(err)) return;
        toast({
          title: t("toast_error_title"),
          variant: "destructive",
        });
      }
    });
  };

  const handleAcknowledge = () => {
    startAcknowledgeTransition(async () => {
      try {
        const result = await acknowledgeNewReleaseAction(repoId);
        if (result?.success === false) {
          toast({
            title: t("toast_error_title"),
            description: result.error,
            variant: "destructive",
          });
        }
      } catch (err: unknown) {
        if (reloadIfServerActionStale(err)) return;
        toast({
          title: t("toast_error_title"),
          description: t("toast_acknowledge_error_generic"),
          variant: "destructive",
        });
      }
    });
  };

  const handleMarkAsNew = () => {
    startMarkingAsNewTransition(async () => {
      try {
        const result = await markAsNewAction(repoId);
        if (result?.success) {
          toast({
            title: t("toast_success_title"),
            description: t("toast_mark_as_new_success"),
          });
        } else {
          toast({
            title: t("toast_error_title"),
            description: result?.error ?? t("toast_mark_as_new_error_generic"),
            variant: "destructive",
          });
        }
      } catch (err: unknown) {
        if (reloadIfServerActionStale(err)) return;
        toast({
          title: t("toast_error_title"),
          description: t("toast_mark_as_new_error_generic"),
          variant: "destructive",
        });
      }
    });
  };

  const displayName = packageInfo
    ? `${packageInfo.owner}/${packageInfo.name}`
    : repoId.replace(/^ghcr:/, "");

  const ghcrUrl =
    repoUrl ||
    (packageInfo
      ? `https://github.com/${packageInfo.owner}/${packageInfo.name}/pkgs/container/${packageInfo.name}`
      : "#");

  // ─── Error State ────────────────────────────────────────────────────
  if (error && error.type !== "not_modified") {
    const errorMessage = getErrorMessage(error, tActions);
    return (
      <Card className="border-destructive/50 bg-destructive/10 flex flex-col">
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <CardTitle className="break-words font-semibold text-xl text-red-400">
                <a
                  href={ghcrUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline"
                >
                  {displayName}
                </a>
              </CardTitle>
              <p className="text-sm text-red-400/80">{t("error_title")}</p>
            </div>
            <div className="flex items-center gap-2">
              <Badge
                variant="outline"
                className="border-purple-500/50 text-purple-400 shrink-0"
              >
                <Box className="mr-1 size-3" />
                GHCR
              </Badge>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 shrink-0 text-red-400/80 hover:bg-red-400/10 hover:text-red-400"
                onClick={() => setIsSettingsOpen(true)}
                aria-label={t("settings_button_aria")}
              >
                <Settings className="size-4" />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="grow pt-0 min-w-0">
          <div className="flex h-48 rounded-md border border-destructive/20 bg-background p-4">
            <div className="flex items-center gap-2 text-sm text-red-400">
              <AlertTriangle className="size-4 shrink-0" />
              <p>{errorMessage}</p>
            </div>
          </div>
        </CardContent>
        <CardFooter className="pt-4 flex items-start">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="destructive"
                size="sm"
                disabled={isRemoving || !isOnline}
                aria-disabled={!isOnline}
              >
                {isRemoving ? <Loader2 className="animate-spin" /> : <Trash2 />}
                {t("remove_button")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("confirm_dialog_title")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t.rich("confirm_dialog_description_long", {
                    bold: (chunks) => (
                      <span className="font-bold">{chunks}</span>
                    ),
                    repoId: displayName,
                  })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("cancel_button")}</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={handleRemove}
                  disabled={isRemoving || !isOnline}
                >
                  {isRemoving ? <Loader2 className="animate-spin" /> : null}
                  {t("confirm_button")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardFooter>
      </Card>
    );
  }

  // ─── Skeleton / Loading State ───────────────────────────────────────
  if (!packageInfo) return <PackageCard.Skeleton />;

  const showAcknowledgeFeature = settings.showAcknowledge ?? true;
  const showMarkAsNewButton = settings.showMarkAsNew ?? true;

  // ─── Normal State ───────────────────────────────────────────────────
  const card = (
    <Card
      className={cn(
        "flex flex-col transition-all",
        isNew &&
          showAcknowledgeFeature &&
          "border-l-4 border-l-green-500 ring-2 ring-green-500/30 ring-offset-2 ring-offset-background",
      )}
    >
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <CardTitle className="break-words font-semibold text-xl">
              <a
                href={ghcrUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:underline"
              >
                {displayName}
              </a>
            </CardTitle>
            <p className="text-sm text-muted-foreground break-all">
              {t("monitored_tags_count", {
                count: packageInfo.monitoredTags.length,
              })}
            </p>
          </div>
          <div className="flex flex-col items-end gap-1.5 shrink-0">
            <Badge
              variant="outline"
              className="border-purple-500/50 text-purple-400"
            >
              <Box className="mr-1 size-3" />
              GHCR
            </Badge>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0 text-muted-foreground"
              onClick={() => setIsSettingsOpen(true)}
              ref={settingsButtonRef}
              aria-label={t("settings_button_aria")}
            >
              <Settings className="size-4" />
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="grow pt-0 min-w-0">
        {packageInfo.tagDigests.length > 0 ? (
          <div className="rounded-md border bg-background overflow-hidden">
            <div className="max-h-72 overflow-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 sticky top-0">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium text-muted-foreground">
                      {t("column_tag")}
                    </th>
                    <th className="px-4 py-2 text-left font-medium text-muted-foreground">
                      {t("column_digest")}
                    </th>
                    <th className="px-4 py-2 text-right font-medium text-muted-foreground">
                      {t("column_updated")}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {packageInfo.tagDigests.map((td) => {
                    const isChanged = changedTagSet.has(td.tag);
                    return (
                      <tr
                        key={td.tag}
                        className={cn(
                          "transition-colors",
                          isChanged && "bg-green-500/10",
                        )}
                      >
                        <td className="px-4 py-2">
                          <Badge
                            variant={isChanged ? "default" : "secondary"}
                            className={cn(
                              "font-mono text-xs",
                              isChanged &&
                                "bg-green-600 hover:bg-green-600 text-white",
                            )}
                          >
                            {td.tag}
                          </Badge>
                        </td>
                        <td className="px-4 py-2">
                          <TooltipProvider delayDuration={100}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <code className="font-mono text-xs text-muted-foreground cursor-default">
                                  {truncateDigest(td.digest)}
                                </code>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p className="font-mono text-xs">{td.digest}</p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        </td>
                        <td className="px-4 py-2 text-right text-xs text-muted-foreground whitespace-nowrap">
                          {formattedDigestTimes[td.tag] ?? (
                            <Skeleton className="ml-auto h-4 w-16" />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="flex h-48 items-center justify-center rounded-md border border-dashed">
            <p className="text-center text-sm text-muted-foreground">
              {t("no_tag_data")}
            </p>
          </div>
        )}
      </CardContent>

      <CardFooter className="flex flex-col items-stretch gap-3 pt-4">
        {showAcknowledgeFeature &&
          (isNew ? (
            <TooltipProvider delayDuration={100}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    onClick={handleAcknowledge}
                    disabled={
                      isAcknowledging ||
                      isRemoving ||
                      isMarkingAsNew ||
                      !isOnline
                    }
                    aria-disabled={!isOnline}
                  >
                    {isAcknowledging ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <CheckSquare />
                    )}
                    <span>{t("acknowledge_button")}</span>
                  </Button>
                </TooltipTrigger>
                {!isOnline && (
                  <TooltipContent>
                    <p>{t("offline_tooltip")}</p>
                  </TooltipContent>
                )}
              </Tooltip>
            </TooltipProvider>
          ) : (
            showMarkAsNewButton && (
              <TooltipProvider delayDuration={100}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={handleMarkAsNew}
                      disabled={
                        isAcknowledging ||
                        isRemoving ||
                        isMarkingAsNew ||
                        !isOnline
                      }
                      aria-disabled={!isOnline}
                    >
                      {isMarkingAsNew ? (
                        <Loader2 className="animate-spin" />
                      ) : (
                        <BellPlus />
                      )}
                      <span>{t("mark_as_new_button")}</span>
                    </Button>
                  </TooltipTrigger>
                  {!isOnline && (
                    <TooltipContent>
                      <p>{t("offline_tooltip")}</p>
                    </TooltipContent>
                  )}
                </Tooltip>
              </TooltipProvider>
            )
          ))}

        <div className="flex items-center justify-between">
          <AlertDialog>
            <TooltipProvider delayDuration={100}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground"
                      disabled={isRemoving || isMarkingAsNew || !isOnline}
                      aria-disabled={!isOnline}
                    >
                      {isRemoving ? (
                        <Loader2 className="animate-spin" />
                      ) : (
                        <Trash2 />
                      )}
                      {t("remove_button")}
                    </Button>
                  </AlertDialogTrigger>
                </TooltipTrigger>
                {!isOnline && (
                  <TooltipContent>
                    <p>{t("offline_tooltip")}</p>
                  </TooltipContent>
                )}
              </Tooltip>
            </TooltipProvider>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("confirm_dialog_title")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t.rich("confirm_dialog_description_long", {
                    bold: (chunks) => (
                      <span className="font-bold">{chunks}</span>
                    ),
                    repoId: displayName,
                  })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("cancel_button")}</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={handleRemove}
                  disabled={isRemoving || !isOnline}
                >
                  {isRemoving ? <Loader2 className="animate-spin" /> : null}
                  {t("confirm_button")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <Button asChild variant="ghost" size="sm">
            <a href={ghcrUrl} target="_blank" rel="noopener noreferrer">
              {t("view_on_github")} <ExternalLink />
            </a>
          </Button>
        </div>
      </CardFooter>
    </Card>
  );

  return (
    <>
      {card}
      <PackageSettingsDialog
        repoId={repoId}
        currentTags={packageInfo?.monitoredTags ?? []}
        appriseTags={enrichedRelease.repoSettings?.appriseTags}
        appriseFormat={enrichedRelease.repoSettings?.appriseFormat}
        globalAppriseTags={settings.appriseTags}
        globalAppriseFormat={settings.appriseFormat}
        isAppriseConfigured={false}
        open={isSettingsOpen}
        onOpenChange={setIsSettingsOpen}
      />
    </>
  );
}

PackageCard.Skeleton = function PackageCardSkeleton() {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <Skeleton className="h-6 w-3/4" />
            <Skeleton className="mt-1 h-4 w-1/3" />
          </div>
          <Skeleton className="h-6 w-16 shrink-0" />
        </div>
      </CardHeader>
      <CardContent>
        <Skeleton className="h-48 w-full" />
      </CardContent>
      <CardFooter className="justify-between pt-4">
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-8 w-32" />
      </CardFooter>
    </Card>
  );
};
