export function isSameOriginRequest(
  origin: string,
  protocol: string,
  host: string | undefined
): boolean {
  if (!host || (protocol !== "http" && protocol !== "https")) {
    return false;
  }

  try {
    return new URL(origin).origin === new URL(`${protocol}://${host}`).origin;
  } catch {
    return false;
  }
}
