export function toPortableRelativePath(value: string): string {
  return value.replace(/\\/g, "/");
}
