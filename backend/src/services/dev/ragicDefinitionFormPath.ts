export function isSafeRagicDefinitionFormPath(formPath: string): boolean {
  const parts = formPath.split("/");
  return (
    parts.length >= 3 &&
    parts.every(
      (part) =>
        part !== "." &&
        part !== ".." &&
        /^[A-Za-z0-9_-](?:[A-Za-z0-9_.-]*[A-Za-z0-9_-])?$/.test(part)
    )
  );
}
