import { runWithFinalizer } from "./services/runLifecycle.js";

export interface AgentBootstrapDependencies {
  cleanup(): Promise<void>;
  validatePauseConfiguration(): Promise<void>;
  loadAndRunAgent(): Promise<void>;
  pause(): Promise<void>;
  onSuppressedPauseError?(error: unknown): void;
}

const DEFAULT_DEPENDENCIES: AgentBootstrapDependencies = {
  cleanup: async () => {
    const { resetFrameworkState } = await import("./neon.js");
    const { CONFIG, DatabaseClient } = await import("freetier-deepagent-framework");
    const db = new DatabaseClient(CONFIG.NEON_DATABASE_URL);
    await resetFrameworkState(db);
  },
  validatePauseConfiguration: async () => {
    const { buildVmPauseUrl } = await import("./services/vmPauseService.js");
    buildVmPauseUrl();
  },
  loadAndRunAgent: async () => {
    const { runAgent } = await import("./agent.js");
    await runAgent();
  },
  pause: async () => {
    const { pauseVm } = await import("./services/vmPauseService.js");
    await pauseVm();
  },
};

/** Canonical lifecycle for both development and compiled production entrypoints. */
export async function runAgentBootstrap(
  dependencies: AgentBootstrapDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
  await runWithFinalizer({
    run: async () => {
      // This must stay the first awaited operational step.
      await dependencies.cleanup();
      await dependencies.validatePauseConfiguration();
      await dependencies.loadAndRunAgent();
    },
    finalize: dependencies.pause,
    onSuppressedFinalizeError: dependencies.onSuppressedPauseError,
  });
}
