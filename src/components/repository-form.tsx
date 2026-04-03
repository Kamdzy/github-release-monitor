"use client";

import { Loader2, Plus, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import * as React from "react";
import { useActionState } from "react";

import {
  addPackagesAction,
  addRepositoriesAction,
  getJobStatusAction,
  importRepositoriesAction,
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
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { useNetworkStatus } from "@/hooks/use-network";
import { useToast } from "@/hooks/use-toast";
import { reloadIfServerActionStale } from "@/lib/server-action-error";
import { cn } from "@/lib/utils";
import type { Repository } from "@/types";

function SubmitButton({
  isDisabled,
  isPending,
}: {
  isDisabled: boolean;
  isPending: boolean;
}) {
  const t = useTranslations("RepositoryForm");

  return (
    <Button
      type="submit"
      className="w-full sm:w-auto"
      disabled={isPending || isDisabled}
    >
      {isPending ? (
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      ) : (
        <Plus className="mr-2 h-4 w-4" />
      )}
      {t("button_add")}
    </Button>
  );
}

const initialState = {
  success: false,
  toast: undefined,
  error: undefined,
};

interface RepositoryFormProps {
  currentRepositories: Repository[];
}

export function RepositoryForm({ currentRepositories }: RepositoryFormProps) {
  const t = useTranslations("RepositoryForm");
  const tp = useTranslations("PackageForm");
  const [urls, setUrls] = React.useState("");
  const { toast } = useToast();
  const router = useRouter();
  const { isOnline } = useNetworkStatus();
  const [activeTab, setActiveTab] = React.useState<"releases" | "packages">(
    "releases",
  );
  const [packageUrls, setPackageUrls] = React.useState("");
  const [packageTags, setPackageTags] = React.useState("");
  const [pkgState, pkgFormAction, isPkgPending] = useActionState(
    addPackagesAction,
    initialState,
  );
  const [pkgJobId, setPkgJobId] = React.useState<string | undefined>(undefined);
  const hasPkgProcessedResult = React.useRef(true);

  const [state, formAction, isPending] = useActionState(
    addRepositoriesAction,
    initialState,
  );
  const [jobId, setJobId] = React.useState<string | undefined>(undefined);
  const hasProcessedResult = React.useRef(true);

  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const [isImporting, startImportTransition] = React.useTransition();
  const [isDialogVisible, setIsDialogVisible] = React.useState(false);
  const [reposToImport, setReposToImport] = React.useState<Repository[] | null>(
    null,
  );
  const [importStats, setImportStats] = React.useState<{
    newCount: number;
    existingCount: number;
  } | null>(null);
  const [fileInputKey, setFileInputKey] = React.useState(Date.now());

  React.useEffect(() => {
    if (isPending) {
      hasProcessedResult.current = false;
    }
  }, [isPending]);

  React.useEffect(() => {
    if (state.error) {
      toast({
        title: t("toast_fail_title"),
        description: state.error,
        variant: "destructive",
      });
      hasProcessedResult.current = true;
    }
    if (state.toast && !hasProcessedResult.current) {
      toast({
        title: state.toast.title,
        description: state.toast.description,
      });
    }
    if (state.success && !hasProcessedResult.current) {
      hasProcessedResult.current = true;
      setUrls("");
      if (state.jobId) {
        setJobId(state.jobId);
      }
    }
  }, [state, t, toast]);

  React.useEffect(() => {
    if (!jobId) return;

    const POLLING_INTERVAL = 2000; // 2 seconds
    const POLLING_TIMEOUT = 5 * 60 * 1000; // 5 minutes

    const startTime = Date.now();

    const intervalId = setInterval(async () => {
      if (Date.now() - startTime > POLLING_TIMEOUT) {
        clearInterval(intervalId);
        toast({
          title: t("toast_refresh_timeout_title"),
          description: t("toast_refresh_timeout_description"),
          variant: "destructive",
        });
        setJobId(undefined);
        return;
      }

      try {
        const { status } = await getJobStatusAction(jobId);

        if (status === "complete") {
          clearInterval(intervalId);
          toast({
            title: t("toast_refresh_success_title"),
            description: t("toast_refresh_success_description"),
          });
          router.refresh();
          setJobId(undefined);
        } else if (status === "error") {
          clearInterval(intervalId);
          toast({
            title: t("toast_refresh_error_title"),
            description: t("toast_refresh_error_description"),
            variant: "destructive",
          });
          setJobId(undefined);
        }
      } catch (error: unknown) {
        clearInterval(intervalId);
        if (reloadIfServerActionStale(error)) {
          return;
        }
        toast({
          title: t("toast_refresh_error_title"),
          description: t("toast_refresh_error_description"),
          variant: "destructive",
        });
        setJobId(undefined);
      }
    }, POLLING_INTERVAL);

    return () => clearInterval(intervalId);
  }, [jobId, router, t, toast]);

  React.useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;

    if (!urls) {
      textarea.scrollTop = 0;
    }
  }, [urls]);

  // Package form effects
  React.useEffect(() => {
    if (isPkgPending) {
      hasPkgProcessedResult.current = false;
    }
  }, [isPkgPending]);

  React.useEffect(() => {
    if (pkgState.error) {
      toast({
        title: tp("toast_generic_error"),
        description: pkgState.error,
        variant: "destructive",
      });
      hasPkgProcessedResult.current = true;
    }
    if (pkgState.toast && !hasPkgProcessedResult.current) {
      toast({
        title: pkgState.toast.title,
        description: pkgState.toast.description,
      });
    }
    if (pkgState.success && !hasPkgProcessedResult.current) {
      hasPkgProcessedResult.current = true;
      setPackageUrls("");
      if (pkgState.jobId) {
        setPkgJobId(pkgState.jobId);
      }
    }
  }, [pkgState, tp, toast]);

  React.useEffect(() => {
    if (!pkgJobId) return;
    const POLLING_INTERVAL = 2000;
    const POLLING_TIMEOUT = 5 * 60 * 1000;
    const startTime = Date.now();
    const intervalId = setInterval(async () => {
      if (Date.now() - startTime > POLLING_TIMEOUT) {
        clearInterval(intervalId);
        setPkgJobId(undefined);
        return;
      }
      try {
        const result = await getJobStatusAction(pkgJobId);
        if (reloadIfServerActionStale(result)) return;
        if (result?.status === "complete" || result?.status === "error") {
          clearInterval(intervalId);
          setPkgJobId(undefined);
          router.refresh();
        }
      } catch {
        clearInterval(intervalId);
        setPkgJobId(undefined);
      }
    }, POLLING_INTERVAL);
    return () => clearInterval(intervalId);
  }, [pkgJobId, router]);

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const content = e.target?.result as string;
        const importedData = JSON.parse(content);

        if (Array.isArray(importedData)) {
          const isValidFormat = importedData.every(
            (item) =>
              typeof item === "object" &&
              item !== null &&
              "id" in item &&
              "url" in item,
          );

          if (!isValidFormat) {
            throw new Error(t("toast_import_error_invalid_format"));
          }

          const existingIds = new Set(
            currentRepositories.map((repo) => repo.id),
          );
          const newRepos = importedData.filter(
            (repo) => !existingIds.has(repo.id),
          );
          const existingCount = importedData.length - newRepos.length;

          setReposToImport(importedData);
          setImportStats({ newCount: newRepos.length, existingCount });
          setIsDialogVisible(true);
        } else {
          toast({
            title: t("toast_import_error_title"),
            description: t("toast_import_error_invalid_format"),
            variant: "destructive",
          });
        }
      } catch (error: unknown) {
        const description =
          error instanceof Error && error.message
            ? error.message
            : typeof error === "string"
              ? error
              : t("toast_import_error_parsing");
        toast({
          title: t("toast_import_error_title"),
          description,
          variant: "destructive",
        });
      }
    };
    reader.onerror = () => {
      toast({
        title: t("toast_import_error_title"),
        description: t("toast_import_error_reading"),
        variant: "destructive",
      });
    };
    reader.readAsText(file);
    setFileInputKey(Date.now());
  };

  const handleConfirmImport = () => {
    if (!reposToImport) return;

    startImportTransition(async () => {
      try {
        const result = await importRepositoriesAction(reposToImport);

        if (result.success) {
          toast({
            title: t("toast_import_success_title"),
            description: result.message,
          });
          if (result.jobId) {
            setJobId(result.jobId);
          }
        } else {
          toast({
            title: t("toast_import_error_title"),
            description: result.message,
            variant: "destructive",
          });
        }
      } catch (error: unknown) {
        if (reloadIfServerActionStale(error)) {
          return;
        }
        toast({
          title: t("toast_import_error_title"),
          description: t("toast_import_error_description"),
          variant: "destructive",
        });
      } finally {
        setIsDialogVisible(false);
        setReposToImport(null);
        setImportStats(null);
      }
    });
  };

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2 mb-2">
            <button
              type="button"
              onClick={() => setActiveTab("releases")}
              className={cn(
                "px-3 py-1.5 text-sm font-medium rounded-md transition-colors",
                activeTab === "releases"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted",
              )}
            >
              {tp("tab_releases")}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("packages")}
              className={cn(
                "px-3 py-1.5 text-sm font-medium rounded-md transition-colors",
                activeTab === "packages"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted",
              )}
            >
              {tp("tab_packages")}
            </button>
          </div>
          <CardTitle>
            {activeTab === "releases" ? t("title") : tp("title")}
          </CardTitle>
          <CardDescription>
            {activeTab === "releases" ? t("description") : tp("description")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {activeTab === "releases" ? (
            <form
              action={formAction}
              onSubmit={(e) => {
                if (typeof navigator !== "undefined" && !navigator.onLine) {
                  e.preventDefault();
                  toast({
                    title: t("toast_fail_title"),
                    description: t("toast_generic_error"),
                    variant: "destructive",
                  });
                }
              }}
            >
              <div className="grid w-full gap-2">
                <Textarea
                  ref={textareaRef}
                  name="urls"
                  placeholder={t("placeholder")}
                  value={urls}
                  onChange={(e) => setUrls(e.target.value)}
                  rows={4}
                  wrap="off"
                  className="resize-none overflow-y-auto overflow-x-auto max-h-80"
                  disabled={isPending || !!jobId}
                />
                <div className="flex flex-col-reverse sm:flex-row sm:justify-end sm:gap-2">
                  <input
                    key={fileInputKey}
                    type="file"
                    ref={fileInputRef}
                    onChange={handleFileChange}
                    accept=".json"
                    className="hidden"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleImportClick}
                    className="mt-2 w-full sm:mt-0 sm:w-auto"
                    disabled={isPending || isImporting || !!jobId || !isOnline}
                  >
                    {isImporting ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Upload className="mr-2 h-4 w-4" />
                    )}
                    {t("button_import")}
                  </Button>
                  <SubmitButton
                    isDisabled={!urls.trim() || !isOnline}
                    isPending={isPending || !!jobId}
                  />
                </div>
              </div>
            </form>
          ) : (
            <form
              action={pkgFormAction}
              onSubmit={(e) => {
                if (typeof navigator !== "undefined" && !navigator.onLine) {
                  e.preventDefault();
                  toast({
                    title: tp("toast_generic_error"),
                    description: tp("toast_generic_error"),
                    variant: "destructive",
                  });
                }
              }}
            >
              <div className="grid w-full gap-3">
                <Textarea
                  name="urls"
                  placeholder={tp("placeholder")}
                  value={packageUrls}
                  onChange={(e) => setPackageUrls(e.target.value)}
                  rows={3}
                  wrap="off"
                  className="resize-none overflow-y-auto overflow-x-auto max-h-60"
                  disabled={isPkgPending || !!pkgJobId}
                />
                <div>
                  <label
                    htmlFor="pkg-tags"
                    className="text-sm font-medium mb-1 block"
                  >
                    {tp("tags_label")}
                  </label>
                  <Input
                    id="pkg-tags"
                    name="tags"
                    placeholder={tp("tags_placeholder")}
                    value={packageTags}
                    onChange={(e) => setPackageTags(e.target.value)}
                    disabled={isPkgPending || !!pkgJobId}
                  />
                </div>
                <div className="flex justify-end">
                  <Button
                    type="submit"
                    disabled={
                      !packageUrls.trim() ||
                      !packageTags.trim() ||
                      isPkgPending ||
                      !!pkgJobId ||
                      !isOnline
                    }
                  >
                    {isPkgPending || !!pkgJobId ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : null}
                    {tp("button_add")}
                  </Button>
                </div>
              </div>
            </form>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={isDialogVisible} onOpenChange={setIsDialogVisible}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("import_dialog_title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {importStats &&
                t("import_dialog_description", {
                  newCount: importStats.newCount,
                  existingCount: importStats.existingCount,
                })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isImporting}>
              {t("cancel_button")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmImport}
              disabled={isImporting}
            >
              {isImporting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              {t("import_dialog_confirm_button")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
