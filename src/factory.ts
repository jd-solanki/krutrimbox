export const FACTORY_OWNER = "jd-solanki";

export interface CodeFactoryRunner {
  runExplicit(prdNumber: number): Promise<void>;
  runBatch(): Promise<void>;
}

export const runCodeFactory: CodeFactoryRunner = {
  async runExplicit(prdNumber: number): Promise<void> {
    console.log(`Code Factory: starting Explicit Run for PRD #${prdNumber}.`);
    console.log(`Code Factory: processing only Factory-Owned PRDs by ${FACTORY_OWNER}.`);
  },

  async runBatch(): Promise<void> {
    console.log("Code Factory: starting Batch Run for ready PRDs.");
    console.log(`Code Factory: discovering Factory-Owned PRDs by ${FACTORY_OWNER}.`);
  }
};
