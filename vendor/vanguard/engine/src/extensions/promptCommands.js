import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asciiLowercase, compareOrdinal } from "../deterministicText.js";
const COMMAND_DIRECTORY = path.join(".vanguard", "commands");
const MAX_COMMANDS = 64;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;
const MAX_DESCRIPTION = 200;
export async function loadPromptCommands(options) {
    if (options.disableExtensions === true)
        return [];
    const byName = new Map();
    let totalBytes = 0;
    const layers = [
        { directory: path.join(options.userHome ?? os.homedir(), COMMAND_DIRECTORY), scope: "user" },
        { directory: path.join(options.workspaceRoot, COMMAND_DIRECTORY), scope: "workspace" },
    ];
    for (const layer of layers) {
        for (const file of await commandFiles(layer.directory)) {
            if (byName.size >= MAX_COMMANDS)
                break;
            const contents = await readFile(file).catch(() => undefined);
            if (contents === undefined)
                continue;
            if (contents.byteLength > MAX_FILE_BYTES)
                continue;
            totalBytes += contents.byteLength;
            if (totalBytes > MAX_TOTAL_BYTES)
                return sorted(byName);
            let text;
            try {
                text = new TextDecoder("utf-8", { fatal: true }).decode(contents).replaceAll("\r\n", "\n");
            }
            catch {
                continue;
            }
            const name = commandName(file);
            if (name === undefined)
                continue;
            const parsed = parseTemplate(text);
            if (parsed === undefined)
                continue;
            byName.set(name, {
                name,
                description: parsed.description ?? defaultDescription(parsed.template),
                template: parsed.template,
                source: file,
                scope: layer.scope,
                sha256: createHash("sha256").update(contents).digest("hex"),
            });
        }
    }
    return sorted(byName);
}
export function expandPromptCommand(command, argumentText) {
    const args = argumentText.trim();
    const positional = tokenize(args);
    let used = false;
    let expanded = command.template.replace(/\$(ARGUMENTS|[1-9])/gu, (_match, token) => {
        used = true;
        if (token === "ARGUMENTS")
            return args;
        return positional[Number(token) - 1] ?? "";
    });
    if (!used && args.length > 0)
        expanded = `${expanded}\n\n${args}`;
    return expanded.trim();
}
function tokenize(text) {
    const tokens = [];
    for (const match of text.matchAll(/"([^"]*)"|(\S+)/gu)) {
        tokens.push(match[1] ?? match[2] ?? "");
    }
    return tokens;
}
async function commandFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => undefined);
    if (entries === undefined)
        return [];
    const files = [];
    for (const entry of entries.sort((a, b) => compareOrdinal(a.name, b.name))) {
        if (entry.isSymbolicLink() || !entry.isFile())
            continue;
        if (asciiLowercase(path.extname(entry.name)) !== ".md")
            continue;
        const resolved = await realpath(path.join(directory, entry.name)).catch(() => undefined);
        if (resolved !== undefined)
            files.push(resolved);
    }
    return files;
}
function commandName(file) {
    const name = asciiLowercase(path.basename(file, path.extname(file)));
    return /^[a-z][a-z0-9_-]{0,31}$/.test(name) ? name : undefined;
}
function parseTemplate(text) {
    let body = text;
    let description;
    if (body.startsWith("---\n")) {
        const end = body.indexOf("\n---\n", 4);
        if (end >= 0) {
            for (const line of body.slice(4, end).split("\n")) {
                const match = /^description:\s*(.+)$/u.exec(line.trim());
                if (match?.[1] !== undefined)
                    description = unquote(match[1].trim()).slice(0, MAX_DESCRIPTION);
            }
            body = body.slice(end + 5);
        }
    }
    const template = body.trim();
    if (template.length === 0)
        return undefined;
    return description === undefined ? { template } : { template, description };
}
function defaultDescription(template) {
    const firstLine = template.split("\n").find((line) => line.trim().length > 0) ?? "";
    const cleaned = firstLine.replace(/^#+\s*/u, "").trim();
    return cleaned.length > MAX_DESCRIPTION ? `${cleaned.slice(0, MAX_DESCRIPTION - 1)}…` : cleaned;
}
function unquote(value) {
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1);
    }
    return value;
}
function sorted(byName) {
    return [...byName.values()].sort((left, right) => compareOrdinal(left.name, right.name));
}
