export interface RunLifecycleOptions<T> {
  run(): Promise<T>;
  finalize(): Promise<void>;
  onSuppressedFinalizeError?: (error: unknown) => void;
}

/**
 * Always awaits the final action. If both operations fail, the original run
 * error remains authoritative while the finalization error is reported.
 */
export async function runWithFinalizer<T>(options: RunLifecycleOptions<T>): Promise<T> {
  let primaryFailed = false;
  try {
    return await options.run();
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    try {
      await options.finalize();
    } catch (error) {
      if (primaryFailed) {
        try {
          (options.onSuppressedFinalizeError ?? ((value) => {
            console.error("Final lifecycle action also failed:", value);
          }))(error);
        } catch (diagnosticError) {
          // Diagnostics must never replace the original run failure.
          console.error("Unable to report final lifecycle failure:", diagnosticError);
        }
      } else {
        throw error;
      }
    }
  }
}
