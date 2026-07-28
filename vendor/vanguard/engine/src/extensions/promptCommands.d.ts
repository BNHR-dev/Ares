export type PromptCommandScope = "user" | "workspace";
export interface PromptCommand {
    readonly name: string;
    readonly description: string;
    readonly template: string;
    readonly source: string;
    readonly scope: PromptCommandScope;
    readonly sha256: string;
}
export interface LoadPromptCommandOptions {
    readonly workspaceRoot: string;
    readonly userHome?: string;
    /** Mirrors --no-extensions: hermetic runs discover nothing. */
    readonly disableExtensions?: boolean;
}
/**
 * Loads user then workspace commands. A workspace command shadows a user
 * command of the same name — the same "nearer definition wins" rule the
 * instruction and config hierarchy already follows.
 */
export declare function loadPromptCommands(options: LoadPromptCommandOptions): Promise<readonly PromptCommand[]>;
/**
 * Substitutes `$ARGUMENTS` and `$1`..`$9`. When a template references neither
 * and the caller supplied arguments, they are appended instead of silently
 * discarded — a typed argument must always reach the model.
 */
export declare function expandPromptCommand(command: PromptCommand, argumentText: string): string;
