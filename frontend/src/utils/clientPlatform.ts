import type { ClientPlatform } from "../types.js";

interface NavigatorLike {
  userAgent?: string;
  platform?: string;
  userAgentData?: {
    platform?: string;
  };
}

function classifyPlatformString(value: string): ClientPlatform {
  const normalized = value.trim().toLowerCase();

  if (!normalized) {
    return "unknown";
  }

  if (normalized.includes("win")) {
    return "windows";
  }

  if (normalized.includes("mac")) {
    return "macos";
  }

  if (normalized.includes("linux") || normalized.includes("x11")) {
    return "linux";
  }

  return "unknown";
}

export function detectClientPlatform(navigatorLike?: NavigatorLike | null): ClientPlatform {
  const source = navigatorLike ?? (typeof navigator !== "undefined" ? navigator as NavigatorLike : null);
  if (!source) {
    return "unknown";
  }

  const preferredValue = source.userAgentData?.platform || source.platform || source.userAgent || "";
  return classifyPlatformString(preferredValue);
}
