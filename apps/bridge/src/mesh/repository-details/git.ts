import { readRepositoryGit } from "../catalog";

export async function git(path: string, args: string[]): Promise<string | undefined> {
  const output = await readRepositoryGit(path, args, { maxBuffer: 256 * 1_024 });
  return output?.trim();
}
