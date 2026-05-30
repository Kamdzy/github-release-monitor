import { isValidRepoId } from "@/lib/repositories/validation";

// Parses GHCR package URLs into their components.
// Supports:
//   https://github.com/hotio/qbittorrent/pkgs/container/qbittorrent
//   https://github.com/orgs/my-org/packages/container/package/my-image
//   ghcr.io/hotio/qbittorrent (shorthand)
export function parseGhcrPackageUrl(url: string): {
  owner: string;
  packageName: string;
  ownerType: "users" | "orgs";
  id: string;
} | null {
  try {
    const trimmed = url.trim();
    if (!trimmed) return null;

    if (
      trimmed.startsWith("ghcr.io/") ||
      trimmed.startsWith("https://ghcr.io/")
    ) {
      const urlStr = trimmed.startsWith("https://")
        ? trimmed
        : `https://${trimmed}`;
      const urlObj = new URL(urlStr);
      const parts = urlObj.pathname.split("/").filter(Boolean);
      if (parts.length >= 2) {
        const owner = parts[0].toLowerCase();
        const packageName = parts[1].toLowerCase();
        return {
          owner,
          packageName,
          ownerType: "users",
          id: `ghcr:${owner}/${packageName}`,
        };
      }
      return null;
    }

    const urlObj = new URL(trimmed);
    if (urlObj.hostname !== "github.com") return null;
    const parts = urlObj.pathname.split("/").filter(Boolean);

    if (
      parts.length >= 5 &&
      parts[0] === "orgs" &&
      parts[2] === "packages" &&
      parts[3] === "container"
    ) {
      const owner = parts[1].toLowerCase();
      const packageName = (
        parts[4] === "package" && parts[5] ? parts[5] : parts[4]
      ).toLowerCase();
      return {
        owner,
        packageName,
        ownerType: "orgs",
        id: `ghcr:${owner}/${packageName}`,
      };
    }

    if (
      parts.length >= 4 &&
      parts[2] === "pkgs" &&
      parts[3] === "container" &&
      parts[4]
    ) {
      const owner = parts[0].toLowerCase();
      const packageName = parts[4].toLowerCase();
      return {
        owner,
        packageName,
        ownerType: "users",
        id: `ghcr:${owner}/${packageName}`,
      };
    }

    return null;
  } catch {
    return null;
  }
}

export function isValidPackageId(id: string): boolean {
  if (typeof id !== "string") return false;
  return /^ghcr:[a-z0-9-._]+\/[a-z0-9-._]+$/i.test(id);
}

export function isValidItemId(id: string): boolean {
  return isValidRepoId(id) || isValidPackageId(id);
}
