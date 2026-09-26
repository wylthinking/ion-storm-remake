export function decodeStaticRequestPath(pathname: string): string | undefined {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
}

export function isProtectedAdvancedAiAssetPath(pathname: string): boolean {
  return /(?:^|\/)(?:advancedAiWorker|advanced-ai)(?:[./_-]|$)/i.test(pathname);
}

export function safeCookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  const entry = header
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  if (!entry) return undefined;
  try {
    return decodeURIComponent(entry.slice(name.length + 1));
  } catch {
    return undefined;
  }
}
