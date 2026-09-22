import fs from "fs";

function resolveDeployVersion(): string {
  const candidatePath = process.argv[1] || __filename;
  try {
    const stat = fs.statSync(candidatePath);
    return `${Math.floor(stat.mtimeMs)}-${stat.size}`;
  } catch {
    return "dev";
  }
}

export const SERVER_DEPLOY_VERSION = resolveDeployVersion();
