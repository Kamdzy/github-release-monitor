"use client";

import { AlertCircle, CheckCircle, Loader2, Save, WifiOff } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import {
  refreshSingleRepositoryAction,
  updatePackageSettingsAction,
} from "@/app/actions";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useNetworkStatus } from "@/hooks/use-network";
import { useToast } from "@/hooks/use-toast";
import { reloadIfServerActionStale } from "@/lib/server-action-error";
import { cn } from "@/lib/utils";
import type { AppriseFormat } from "@/types";

type SaveStatus =
  | "idle"
  | "waiting"
  | "saving"
  | "success"
  | "error"
  | "paused";

function SaveStatusIndicator({ status }: { status: SaveStatus }) {
  const t = useTranslations("PackageSettings");

  if (status === "idle") {
    return null;
  }

  const messages: Record<
    SaveStatus,
    { text: React.ReactNode; icon: React.ReactNode; className: string }
  > = {
    idle: { text: "", icon: null, className: "" },
    waiting: {
      text: t("autosave_waiting"),
      icon: <Save className="size-4" />,
      className: "text-muted-foreground",
    },
    saving: {
      text: t("autosave_saving"),
      icon: <Loader2 className="size-4 animate-spin" />,
      className: "text-muted-foreground",
    },
    success: {
      text: t("autosave_success"),
      icon: <CheckCircle className="size-4" />,
      className: "text-green-500",
    },
    error: {
      text: t("autosave_error"),
      icon: <AlertCircle className="size-4" />,
      className: "text-destructive",
    },
    paused: {
      text: t("autosave_paused_offline"),
      icon: <WifiOff className="size-4" />,
      className: "text-yellow-500",
    },
  };

  const current = messages[status];

  return (
    <div
      className={cn(
        "flex items-center justify-end gap-2 text-sm transition-colors",
        current.className,
      )}
    >
      {current.icon}
      <span>{current.text}</span>
    </div>
  );
}

interface PackageSettingsDialogProps {
  repoId: string;
  currentTags: string[];
  appriseTags?: string;
  appriseFormat?: string;
  globalAppriseTags?: string;
  globalAppriseFormat?: string;
  isAppriseConfigured: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PackageSettingsDialog({
  repoId,
  currentTags,
  appriseTags: initialAppriseTags,
  appriseFormat: initialAppriseFormat,
  globalAppriseTags,
  globalAppriseFormat,
  isAppriseConfigured,
  open,
  onOpenChange,
}: PackageSettingsDialogProps) {
  const t = useTranslations("PackageSettings");
  const { toast } = useToast();
  const { isOnline } = useNetworkStatus();

  const monitoredTagsId = React.useId();
  const appriseTagsId = React.useId();
  const appriseFormatId = React.useId();

  const [monitoredTags, setMonitoredTags] = React.useState(
    currentTags.join(", "),
  );
  const [tagsError, setTagsError] = React.useState(false);
  const [appriseTags, setAppriseTags] = React.useState(
    initialAppriseTags ?? "",
  );
  const [appriseFormat, setAppriseFormat] = React.useState<AppriseFormat | "">(
    (initialAppriseFormat as AppriseFormat) ?? "",
  );

  const [saveStatus, setSaveStatus] = React.useState<SaveStatus>("idle");

  const savedThisSessionRef = React.useRef(false);
  const mountedRef = React.useRef(true);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Reset state when the dialog opens
  const prevOpenRef = React.useRef(open);
  React.useEffect(() => {
    const wasOpen = prevOpenRef.current;

    if (!wasOpen && open) {
      setMonitoredTags(currentTags.join(", "));
      setAppriseTags(initialAppriseTags ?? "");
      setAppriseFormat((initialAppriseFormat as AppriseFormat) ?? "");
      setTagsError(false);
      setSaveStatus("idle");
      savedThisSessionRef.current = false;
      prevSettingsRef.current = {
        monitoredTags: currentTags,
        appriseTags: initialAppriseTags,
        appriseFormat: (initialAppriseFormat as AppriseFormat) || undefined,
      };
    }

    // When closing, refresh if we saved during this session
    if (wasOpen && !open && savedThisSessionRef.current) {
      refreshSingleRepositoryAction(repoId).catch((error: unknown) => {
        if (reloadIfServerActionStale(error)) {
          return;
        }
      });
      savedThisSessionRef.current = false;
    }

    prevOpenRef.current = open;
  }, [open, currentTags, initialAppriseTags, initialAppriseFormat, repoId]);

  // Parse monitored tags from comma-separated string
  const parsedTags = React.useMemo(() => {
    return monitoredTags
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0);
  }, [monitoredTags]);

  // Validate tags whenever input changes
  React.useEffect(() => {
    setTagsError(parsedTags.length === 0);
  }, [parsedTags]);

  // Build the settings object for comparison and saving
  const newSettings = React.useMemo(() => {
    return {
      monitoredTags: parsedTags,
      appriseTags: appriseTags.trim() || undefined,
      appriseFormat: appriseFormat || undefined,
    };
  }, [parsedTags, appriseTags, appriseFormat]);

  const prevSettingsRef = React.useRef(newSettings);

  // Debounced auto-save effect
  React.useEffect(() => {
    if (!open) return;

    if (!isOnline) {
      setSaveStatus("paused");
      return;
    }

    if (
      JSON.stringify(newSettings) === JSON.stringify(prevSettingsRef.current)
    ) {
      return;
    }

    // Do not save if tags are invalid
    if (parsedTags.length === 0) {
      setSaveStatus("idle");
      return;
    }

    setSaveStatus("waiting");

    const handler = setTimeout(async () => {
      if (mountedRef.current) setSaveStatus("saving");

      try {
        const result = await updatePackageSettingsAction(repoId, newSettings);

        if (result.success) {
          if (mountedRef.current) {
            setSaveStatus("success");
            prevSettingsRef.current = newSettings;
            savedThisSessionRef.current = true;
          } else {
            savedThisSessionRef.current = true;
          }
        } else {
          if (mountedRef.current) {
            setSaveStatus("error");
            toast({
              title: t("toast_error_title"),
              description: result.error,
              variant: "destructive",
            });
          }
        }
      } catch (error: unknown) {
        if (reloadIfServerActionStale(error)) {
          return;
        }
        if (mountedRef.current) {
          setSaveStatus("error");
          toast({
            title: t("toast_error_title"),
            description: String(error),
            variant: "destructive",
          });
        }
      }
    }, 500);

    return () => clearTimeout(handler);
  }, [newSettings, repoId, open, parsedTags.length, toast, t, isOnline]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {t.rich("description", {
              repoId: () => (
                <span className="font-semibold text-foreground">{repoId}</span>
              ),
            })}
          </DialogDescription>
        </DialogHeader>

        {!isOnline && (
          <div className="mb-3 mt-2 rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 text-sm text-yellow-300">
            {t("offline_notice")}
          </div>
        )}

        <div className="max-h-[60vh] space-y-6 overflow-y-auto pb-4 pr-2 pt-2 -mr-4">
          {/* Monitored tags */}
          <div className="space-y-4 rounded-md border p-4">
            <h4 className="text-base font-semibold">
              {t("monitored_tags_title")}
            </h4>
            <p className="text-xs text-muted-foreground">
              {t("monitored_tags_description")}
            </p>
            <div className="space-y-2">
              <Label htmlFor={monitoredTagsId}>
                {t("monitored_tags_label")}
              </Label>
              <Input
                id={monitoredTagsId}
                value={monitoredTags}
                onChange={(e) => setMonitoredTags(e.target.value)}
                placeholder={t("monitored_tags_placeholder")}
                className={cn(
                  tagsError &&
                    "border-destructive focus-visible:ring-destructive",
                )}
                disabled={!isOnline}
              />
              {tagsError && (
                <p className="text-sm text-destructive">
                  {t("monitored_tags_error_empty")}
                </p>
              )}
            </div>
          </div>

          {/* Apprise settings (only visible when configured) */}
          {isAppriseConfigured && (
            <div className="space-y-4 rounded-md border p-4">
              <h4 className="text-base font-semibold">
                {t("apprise_settings_title")}
              </h4>

              {/* Apprise format */}
              <div className="space-y-2">
                <Label htmlFor={appriseFormatId}>
                  {t("apprise_format_label")}
                </Label>
                <Select
                  value={appriseFormat}
                  onValueChange={(value: AppriseFormat | "global") =>
                    setAppriseFormat(value === "global" ? "" : value)
                  }
                  disabled={!isOnline}
                >
                  <SelectTrigger id={appriseFormatId}>
                    <SelectValue
                      placeholder={t("apprise_format_placeholder", {
                        format: globalAppriseFormat || "text",
                      })}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="global">
                      {t("apprise_format_option_global", {
                        format: globalAppriseFormat || "text",
                      })}
                    </SelectItem>
                    <SelectItem value="text">
                      {t("apprise_format_text")}
                    </SelectItem>
                    <SelectItem value="markdown">
                      {t("apprise_format_markdown")}
                    </SelectItem>
                    <SelectItem value="html">
                      {t("apprise_format_html")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Apprise tags */}
              <div className="space-y-2">
                <Label htmlFor={appriseTagsId}>{t("apprise_tags_label")}</Label>
                <Input
                  id={appriseTagsId}
                  type="text"
                  value={appriseTags}
                  onChange={(e) => setAppriseTags(e.target.value)}
                  placeholder={t("apprise_tags_placeholder", {
                    tags: globalAppriseTags || "...",
                  })}
                  disabled={!isOnline}
                />
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="pt-4">
          <SaveStatusIndicator status={saveStatus} />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
