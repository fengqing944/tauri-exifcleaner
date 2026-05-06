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
  mirrorOutputDir: string | null;
  videoCleanupMode: VideoCleanupMode;
  targetedImageCleanup: TargetedImageCleanupPreferences;
  metadataWrite: MetadataWritePreferences;
  rememberMetadataWriteContent: boolean;
};

const STORAGE_KEY = "tagsweep.desktop.preferences.v1";

const DEFAULT_PREFERENCES: DesktopPreferences = {
  preferredParallelism: null,
  autoOpenDetailsOnFailure: true,
  reopenRunDetailsOnLaunch: false,
  lastDetailsOpen: false,
  allowReadonlyOverwrite: false,
  cleanupOutputMode: "overwrite",
  mirrorOutputDir: null,
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
  rememberMetadataWriteContent: false,
};

const EMPTY_METADATA_WRITE_CONTENT: MetadataWritePreferences = {
  ...DEFAULT_PREFERENCES.metadataWrite,
};

function sanitizeTextPreference(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  return value.replace(/[\r\n]+/g, " ").trim().slice(0, 240);
}

function sanitizePathPreference(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const sanitized = value.replace(/[\r\n]+/g, " ").trim().slice(0, 2048);
  return sanitized || null;
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

function sanitizeMetadataWrite(
  value: unknown,
  rememberContent: boolean,
): MetadataWritePreferences {
  const record =
    value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const enabled =
    typeof record.enabled === "boolean"
      ? Boolean(record.enabled)
      : DEFAULT_PREFERENCES.metadataWrite.enabled;

  if (!rememberContent) {
    return {
      ...EMPTY_METADATA_WRITE_CONTENT,
      enabled,
    };
  }

  return {
    enabled,
    title: sanitizeTextPreference(record.title),
    author: sanitizeTextPreference(record.author),
    description: sanitizeTextPreference(record.description),
    keywords: sanitizeTextPreference(record.keywords),
    rights: sanitizeTextPreference(record.rights),
    rating: sanitizeTextPreference(record.rating),
    label: sanitizeTextPreference(record.label),
    rightsUrl: sanitizeTextPreference(record.rightsUrl),
  };
}

function preparePreferencesForStorage(
  preferences: DesktopPreferences,
): DesktopPreferences {
  if (preferences.rememberMetadataWriteContent) {
    return preferences;
  }

  return {
    ...preferences,
    metadataWrite: {
      ...EMPTY_METADATA_WRITE_CONTENT,
      enabled: preferences.metadataWrite.enabled,
    },
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
  const rememberMetadataWriteContent =
    typeof record.rememberMetadataWriteContent === "boolean"
      ? Boolean(record.rememberMetadataWriteContent)
      : DEFAULT_PREFERENCES.rememberMetadataWriteContent;

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
    mirrorOutputDir: sanitizePathPreference(record.mirrorOutputDir),
    videoCleanupMode: sanitizeVideoCleanupMode(record.videoCleanupMode),
    targetedImageCleanup: sanitizeTargetedImageCleanup(record.targetedImageCleanup),
    metadataWrite: sanitizeMetadataWrite(
      record.metadataWrite,
      rememberMetadataWriteContent,
    ),
    rememberMetadataWriteContent,
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
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(preparePreferencesForStorage(preferences)),
    );
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
