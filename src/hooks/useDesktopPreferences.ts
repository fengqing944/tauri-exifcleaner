import { useEffect, useState } from "react";

export type DesktopPreferences = {
  preferredParallelism: number | null;
  autoOpenDetailsOnFailure: boolean;
  reopenRunDetailsOnLaunch: boolean;
  lastDetailsOpen: boolean;
};

const STORAGE_KEY = "tagsweep.desktop.preferences.v1";

const DEFAULT_PREFERENCES: DesktopPreferences = {
  preferredParallelism: null,
  autoOpenDetailsOnFailure: true,
  reopenRunDetailsOnLaunch: false,
  lastDetailsOpen: false,
};

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
