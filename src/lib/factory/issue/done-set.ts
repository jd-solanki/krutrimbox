export interface BranchCommitMessageSource {
  listBranchCommitMessages(branchName: string): Promise<string[]>;
}

export function parseDoneSetFromCommitMessages(commitMessages: Iterable<string>): Set<number> {
  const doneSet = new Set<number>();

  for (const message of commitMessages) {
    // Only the explicit footer krutrimbox writes is authoritative; prose
    // mentions of "Refs #N" are not completion markers.
    for (const match of message.matchAll(/^Refs #(\d+)\s*$/gm)) {
      doneSet.add(Number(match[1]));
    }
  }

  return doneSet;
}

export async function fetchDoneSet(
  source: BranchCommitMessageSource,
  branchName: string
): Promise<Set<number>> {
  return parseDoneSetFromCommitMessages(await source.listBranchCommitMessages(branchName));
}
