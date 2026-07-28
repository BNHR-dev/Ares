import { spawn } from "node:child_process";
export function killProcessTree(child, signal) {
    if (process.platform === "win32") {
        if (child.pid !== undefined) {
            try {
                spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], {
                    shell: false,
                    windowsHide: true,
                    stdio: "ignore",
                }).on("error", () => {
                    try {
                        child.kill("SIGKILL");
                    }
                    catch { }
                });
                return;
            }
            catch { }
        }
        try {
            child.kill("SIGKILL");
        }
        catch { }
        return;
    }
    if (child.pid !== undefined) {
        try {
            process.kill(-child.pid, signal);
            return;
        }
        catch { }
    }
    try {
        child.kill(signal);
    }
    catch { }
}
const ESCALATION_MS = 1_000;
const CLOSURE_DEADLINE_MS = process.platform === "win32" ? 2_000 : 1_000;
export async function terminateProcessTree(child, isClosed) {
    if (isClosed())
        return true;
    killProcessTree(child, "SIGTERM");
    if (await waitFor(isClosed, ESCALATION_MS))
        return true;
    killProcessTree(child, "SIGKILL");
    return waitFor(isClosed, CLOSURE_DEADLINE_MS);
}
async function waitFor(condition, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (condition())
            return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return condition();
}
