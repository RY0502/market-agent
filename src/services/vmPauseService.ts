export const VM_PAUSE_TIMEOUT_MS = 10_000;

export interface VmPauseEnvironment {
  PAUSE_BASE_URL?: string;
  machine_NO?: string;
  /** Conventional uppercase alias accepted for existing deployments. */
  MACHINE_NO?: string;
}

export interface PauseVmOptions {
  env?: VmPauseEnvironment;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function buildVmPauseUrl(env: VmPauseEnvironment = process.env): URL {
  const rawBaseUrl = env.PAUSE_BASE_URL?.trim();
  const machineNo = env.machine_NO?.trim() || env.MACHINE_NO?.trim();
  if (!rawBaseUrl) throw new Error("Missing required env var: PAUSE_BASE_URL");
  if (!machineNo) throw new Error("Missing required env var: machine_NO (or MACHINE_NO)");

  const url = new URL(rawBaseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("PAUSE_BASE_URL must use http or https");
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/pause/vm`;
  url.search = "";
  url.hash = "";
  url.searchParams.set("machine", machineNo);
  return url;
}

/** Sends exactly one bounded GET after an agent invocation settles. */
export async function pauseVm(options: PauseVmOptions = {}): Promise<void> {
  const url = buildVmPauseUrl(options.env);
  const timeoutMs = options.timeoutMs ?? VM_PAUSE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("VM pause timeout must be a positive integer");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (options.fetch ?? globalThis.fetch)(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`VM pause request returned HTTP ${response.status}`);
    }
    await response.arrayBuffer();
    console.log(`VM pause request accepted (HTTP ${response.status}).`);
  } finally {
    clearTimeout(timeout);
  }
}
