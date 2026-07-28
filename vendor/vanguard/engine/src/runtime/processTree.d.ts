import { type ChildProcess } from "node:child_process";
/**
 * Process-tree termination.
 *
 * `child.kill()` reaches only the direct child. A wrapper — `cmd.exe /c`, a
 * shell script, an npm lifecycle — leaves its grandchildren alive holding the
 * stdio pipes, so `close` never fires and the caller cannot prove the tree
 * died. That is not academic: it is exactly how a silent installer survived an
 * idle-kill, kept running unsupervised, and permanently fenced a session.
 *
 * The ladder is the same wherever a child must die: signal the whole tree,
 * escalate, then report honestly if closure still cannot be proven.
 */
/** Kills the child and everything it spawned, as one tree. */
export declare function killProcessTree(child: ChildProcess, signal: "SIGTERM" | "SIGKILL"): void;
/**
 * Terminates a tree and reports whether closure was actually observed.
 * `false` means the caller must treat containment as uncertain — never that
 * the process is presumed dead.
 */
export declare function terminateProcessTree(child: ChildProcess, isClosed: () => boolean): Promise<boolean>;
