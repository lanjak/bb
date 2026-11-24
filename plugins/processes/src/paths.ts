export const MAX_MACHINE_PATHS = 64;
export const ENVIRONMENT_PAGE_SIZE = 100;
export const MAX_ENVIRONMENT_PAGES = 50;

export interface PathEnvironment {
  path: string | null;
  status: string;
  hostLifecycle: string;
  updatedAt: number;
  createdAt: number;
}

const LIVE_STATUSES = new Set(["ready", "provisioning", "creating"]);

function priority(environment: PathEnvironment): number {
  return LIVE_STATUSES.has(environment.status) &&
    environment.hostLifecycle === "active"
    ? 1
    : 0;
}

export function selectMachinePaths(
  environments: readonly PathEnvironment[],
  limit: number = MAX_MACHINE_PATHS,
): string[] {
  const ranked = environments
    .filter(
      (environment): environment is PathEnvironment & { path: string } =>
        typeof environment.path === "string" &&
        environment.path !== "" &&
        environment.status !== "destroyed",
    )
    .sort(
      (left, right) =>
        priority(right) - priority(left) ||
        right.updatedAt - left.updatedAt ||
        right.createdAt - left.createdAt,
    );
  return [...new Set(ranked.map((environment) => environment.path))].slice(
    0,
    limit,
  );
}

export async function readAllEnvironments<T>(
  page: (offset: number) => Promise<readonly T[]>,
): Promise<T[]> {
  const all: T[] = [];
  for (let index = 0; index < MAX_ENVIRONMENT_PAGES; index += 1) {
    const rows = await page(index * ENVIRONMENT_PAGE_SIZE);
    all.push(...rows);
    if (rows.length < ENVIRONMENT_PAGE_SIZE) break;
  }
  return all;
}
