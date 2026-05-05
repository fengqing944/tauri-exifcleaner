import { useEffect, useState } from "react";

import type {
  CleanupOutputMode,
  MetadataWritePreferences,
  TargetedImageCleanupPreferences,
  VideoCleanupMode,
} from "../app-shared";

export type DesktopPreferences = {
  preferredParallelism: number | null;
  autoOpenDetailsOnFailure: boolean;
  reopenRunDetailsOnLaunch: boolean;
  lastDetailsOpen: boolean;
  allowReadonlyOverwrite: boolean;
  cleanupOutputMode: CleanupOutputMode;
  videoCleanupMode: VideoCleanupMode;
  targetedImageCleanup: TargetedImageCleanupPreferences;
  metadataWrite: MetadataWritePreferences;
};

const STORAGE_KEY = "tagsweep.desktop.preferences.v1";

const DEFAULT_PREFERENCES: DesktopPreferences = {
  preferredParallelism: null,
  autoOpenDetailsOnFailure: true,
  reopenRunDetailsOnLaunch: false,
  lastDetailsOpen: false,
  allowReadonlyOverwrite: false,
  cleanupOutputMode: "overwrite",
  videoCleanupMode: "safe",
  targetedImageCleanup: {
    enabled: false,
    search: "",
  },
  metadataWrite: {
    enabled: false,
    title: "",
    author: "",
    description: "",
    keywords: "",
    rights: "",
    rating: "",
    label: "",
    rightsUrl: "",
  },
};

function sanitizeTextPreference(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value.replace(/[\r\n]+/g, " ").trim().slice(0, 240);
}

function sanitizeVideoCleanupMode(value: unknown): VideoCleanupMode {
  return value === "strict" ? "strict" : "safe";
}

function sanitizeCleanupOutputMode(value: unknown): CleanupOutputMode {
  return value === "mirror" ? "mirror" : "overwrite";
}

function sanitizeTargetedImageCleanup(value: unknown): TargetedImageCleanupPreferences {
  const record =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    enabled:
      typeof record.enabled === "boolean"
        ? record.enabled
        : DEFAULT_PREFERENCES.targetedImageCleanup.enabled,
    search: sanitizeTextPreference(record.search),
  };
}

function sanitizePreferences(input: unknown): DesktopPreferences {
  if (!input || typeof input !== "object") {
    return DEFAULT_PREFERENCES;
  }

  const record = input as Record<string, unknown>;
  const preferredParallelism =
    typeof record.preferredParallelism === "number" &&
    Number.isFinite(record.preferredParallelism) &&
    record.preferredParallelism >= 1
      ? Math.round(record.preferredParallelism)
      : null;

  return {
    preferredParallelism,
    autoOpenDetailsOnFailure:
      typeof record.autoOpenDetailsOnFailure === "boolean"
        ? record.autoOpenDetailsOnFailure
        : DEFAULT_PREFERENCES.autoOpenDetailsOnFailure,
    reopenRunDetailsOnLaunch:
      typeof record.reopenRunDetailsOnLaunch === "boolean"
        ? record.reopenRunDetailsOnLaunch
        : DEFAULT_PREFERENCES.reopenRunDetailsOnLaunch,
    lastDetailsOpen:
      typeof record.lastDetailsOpen === "boolean"
        ? record.lastDetailsOpen
        : DEFAULT_PREFERENCES.lastDetailsOpen,
    allowReadonlyOverwrite:
      typeof record.allowReadonlyOverwrite === "boolean"
        ? record.allowReadonlyOverwrite
        : DEFAULT_PREFERENCES.allowReadonlyOverwrite,
    cleanupOutputMode: sanitizeCleanupOutputMode(record.cleanupOutputMode),
    videoCleanupMode: sanitizeVideoCleanupMode(record.videoCleanupMode),
    targetedImageCleanup: sanitizeTargetedImageCleanup(record.targetedImageCleanup),
    metadataWrite: {
      enabled:
        typeof (record.metadataWrite as Record<string, unknown> | undefined)?.enabled === "boolean"
          ? Boolean((record.metadataWrite as Record<string, unknown>).enabled)
          : DEFAULT_PREFERENCES.metadataWrite.enabled,
      title: sanitizeTextPreference(
        (record.metadataWrite as Record<string, unknown> | undefined)?.title,
      ),
      author: sanitizeTextPreference(
        (record.metadataWrite as Record<string, unknown> | undefined)?.author,
      ),
      description: sanitizeTextPreference(
        (record.metadataWrite as Record<string, unknown> | undefined)?.description,
      ),
      keywords: sanitizeTextPreference(
        (record.metadataWrite as Record<string, unknown> | undefined)?.keywords,
      ),
      rights: sanitizeTextPreference(
        (record.metadataWrite as Record<string, unknown> | undefined)?.rights,
      ),
      rating: sanitizeTextPreference(
        (record.metadataWrite as Record<string, unknown> | undefined)?.rating,
      ),
      label: sanitizeTextPreference(
        (record.metadataWrite as Record<string, unknown> | undefined)?.label,
      ),
      rightsUrl: sanitizeTextPreference(
        (record.metadataWrite as Record<string, unknown> | undefined)?.rightsUrl,
      ),
    },
  };
}

function loadPreferences(): DesktopPreferences {
  if (typeof window === "undefined") {
    return DEFAULT_PREFERENCES;
  }

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return DEFAULT_PREFERENCES;
    }

    return sanitizePreferences(JSON.parse(stored));
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function useDesktopPreferences() {
  const [preferences, setPreferences] = useState<DesktopPreferences>(() => loadPreferences());

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  }, [preferences]);

  const setPreference = <K extends keyof DesktopPreferences>(
    key: K,
    value: DesktopPreferences[K],
  ) => {
    setPreferences((current) => {
      if (current[key] === value) {
        return current;
      }

      return {
        ...current,
        [key]: value,
      };
    });
  };

  return {
    preferences,
    setPreference,
  };
}
