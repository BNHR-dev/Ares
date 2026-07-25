import path from "node:path";
import { logicalRunEvents } from "../kernel/logicalHistory.js";
import { SESSION_EXCLUDED_DIRECTORIES, TreeSnapshotCache, snapshotTree } from "../runtime/treeSnapshot.js";
import { AdaptiveCommandVerifier, AgentKernel, CheckpointTool, CommandVerifier, adaptiveVerifyMode, isAdaptiveVerifyCommand, CreativeDirectionVerifier, RenderableArtifactVerifier, DeleteFileTool, HeadlessRenderTool, CodeIntelTool, RepoMemoryStore, RepoMemoryTool, ScoutDelegateTool, ImageInspectionTool, JournalEvidenceResolver, GlobTool, ListFilesTool, ProcessTool, prewarmExecutionRuntime, ReadFileTool, ReplaceTextTool, ReviewChangesTool, RunCheckpointLedger, SearchTextTool, WorkspaceBoundary, WorkspaceIntegrityVerifier, WorkspaceMutationPolicy, WorkspaceVersionLedger, WriteFileTool, contractCriterionIds, normalizeContract, FixedCommandTool, PlanLedger, PlanTool, PostEditSyntaxChecker, PublicRunEventPresenter, RepositoryMapTool, StickyContextPolicy, SyntaxCheckTool, SyntaxCommandRunner, UsageLedger, resolveExtensions, ExtensionPermissionPolicy, FileExtensionAuditJournal, HookRunner, McpStdioClient, loadWorkspaceSkills, latestDurableStateAnchor, DelegationCoordinator, CliDelegateRunner, TransactionalDelegateMerger, createDelegationTools, } from "../index.js";
import { boundedEnvironmentInteger, commandAliases } from "./options.js";
import { commandApprover } from "./userChannel.js";
import { createModel } from "./modelFactory.js";
import { combinedObserver, createStreamPresenter, formatDuration, streamPublicEvent } from "./scorecard.js";
export function buildConversationRuntime(session, options, fileJournal, userChannel) {
    const source = new WorkspaceBoundary(session.sourceRoot);
    const versions = new WorkspaceVersionLedger();
    const mutationPolicy = new WorkspaceMutationPolicy(options.editableRoots, options.protectedPaths);
    const { journal, journalActivity, markActivity } = instrumentJournal(fileJournal);
    const conversationTools = [
        new ListFilesTool(source),
        new SearchTextTool(source),
        new GlobTool(source),
        new ReadFileTool(source, 1_000_000, versions),
        new RepositoryMapTool(source, { includeInstructions: !options.disableExtensions }),
        new HeadlessRenderTool(source),
        new ImageInspectionTool(source),
        new CodeIntelTool(source),
    ];
    const kernel = new AgentKernel({
        model: createModel(options, createStreamPresenter(markActivity)),
        tools: [
            ...conversationTools,
            new ScoutDelegateTool(createModel(options), conversationTools),
        ],
        verifiers: [],
        journal,
        ...(options.extensions === undefined ? {} : { workingState: { snapshot: () => ({ extensions: options.extensions }) } }),
        taskAddendum: taskAddendum(options, mutationPolicy),
        ...(userChannel === undefined ? {} : { userChannel }),
        options: {
            maxSteps: options.maxSteps,
            maxContextBytes: options.maxContextBytes,
            maxRepeatedAction: 3,
            interactive: true,
        },
    });
    return { kernel, mutationPolicyDescription: mutationPolicy.describe(), journalActivity };
}
export async function buildExecutionRuntime(session, options, fileJournal, interactive, userChannel) {
    const container = path.dirname(session.metadataFile);
    const workspace = new WorkspaceBoundary(session.workspaceRoot);
    const versions = new WorkspaceVersionLedger();
    const mutationPolicy = new WorkspaceMutationPolicy(options.editableRoots, options.protectedPaths);
    const commandTimeoutMs = Math.min(options.commandTimeoutMs, options.maxDurationMs);
    const idleOption = options.commandIdleTimeoutMs === undefined
        ? {}
        : { idleTimeoutMs: Math.min(options.commandIdleTimeoutMs, commandTimeoutMs) };
    const agentAllowedCommands = options.restrictProcess
        ? [...new Set(["node", ...options.allowedCommands])]
        : [...new Set(["node", "npm", "npx", "git", options.verification.command, ...options.allowedCommands])];
    const processTool = new ProcessTool(workspace, {
        allowedCommands: agentAllowedCommands,
        ...(userChannel === undefined ? {} : { requestApproval: commandApprover(userChannel) }),
        commandAliases: commandAliases(session.workspaceRoot, options.restrictProcess, mutationPolicy.writableAbsoluteRoots(session.workspaceRoot)),
        deniedArgumentPrefixes: options.restrictProcess ? ["--allow-", "--no-permission", "--no-experimental-permission"] : [],
        deniedArgumentSubstrings: options.restrictProcess ? ["console.assert"] : [],
        timeoutMs: commandTimeoutMs,
        ...idleOption,
        maxOutputBytes: 2_000_000,
    });
    const verifierProcessTool = new ProcessTool(workspace, {
        allowedCommands: [options.verification.command],
        commandAliases: commandAliases(session.workspaceRoot, false, []),
        timeoutMs: commandTimeoutMs,
        ...idleOption,
        maxOutputBytes: 2_000_000,
    });
    const publicCheckTool = options.publicCheck === undefined ? undefined : new FixedCommandTool("check_project", "Run the project's trusted public compile and test command with its fixed arguments.", new ProcessTool(workspace, {
        allowedCommands: [options.publicCheck.command],
        commandAliases: commandAliases(session.workspaceRoot, false, []),
        timeoutMs: commandTimeoutMs,
        ...idleOption,
        maxOutputBytes: 2_000_000,
    }), options.publicCheck);
    const verifiers = [
        isAdaptiveVerifyCommand(options.verification)
            ? new AdaptiveCommandVerifier("adaptive verification", session.workspaceRoot, adaptiveVerifyMode(options.verification))
            : new CommandVerifier("required command", verifierProcessTool, options.verification, options.verifierEvidence),
    ];
    if (options.protectedPaths.length > 0 || options.editableRoots.length > 0) {
        verifiers.push(new WorkspaceIntegrityVerifier({
            sourceRoot: session.sourceRoot,
            workspaceRoot: session.workspaceRoot,
            protectedPaths: options.protectedPaths,
            editableRoots: options.editableRoots,
        }));
    }
    const extensionCloseables = [];
    const extensionTools = [];
    let hookRunner;
    let skillsAddendum = "";
    if (options.disableExtensions !== true) {
        const resolved = await resolveExtensions({ workspaceRoot: session.sourceRoot });
        const policy = new ExtensionPermissionPolicy(resolved.config.permissions);
        const needsAudit = resolved.config.mcp.length > 0 || resolved.config.hooks.length > 0;
        const audit = needsAudit
            ? await FileExtensionAuditJournal.open(path.join(container, "extension-audit.jsonl"))
            : undefined;
        for (const server of resolved.config.mcp) {
            const client = await McpStdioClient.connect(workspace, server, policy, audit);
            extensionTools.push(...client.tools());
            extensionCloseables.push(() => client.close());
        }
        if (resolved.config.hooks.length > 0) {
            hookRunner = new HookRunner(workspace, policy, resolved.config.hooks, audit);
        }
        const sourceBoundary = new WorkspaceBoundary(session.sourceRoot);
        const skillRoots = [];
        for (const root of resolved.config.skills.roots) {
            try {
                await sourceBoundary.existing(root);
                skillRoots.push(root);
            }
            catch {
            }
        }
        if (skillRoots.length > 0) {
            const skills = await loadWorkspaceSkills(sourceBoundary, { ...resolved.config.skills, roots: skillRoots });
            if (skills.length > 0) {
                skillsAddendum = "\n\nAvailable workspace skills (apply when relevant to the task):"
                    + skills.map((skill) => `\n### Skill: ${skill.metadata.name} — ${skill.metadata.description}\n${skill.instructions.trim()}`).join("");
            }
        }
    }
    const hasToolHooks = hookRunner !== undefined;
    const withToolHooks = (tool) => !hasToolHooks ? tool : {
        name: tool.name,
        definition: tool.definition,
        execute: async (input, context) => {
            await hookRunner.run("before-tool", context.signal);
            const result = await tool.execute(input, context);
            await hookRunner.run("after-tool", context.signal);
            return result;
        },
    };
    if (hookRunner !== undefined) {
        await hookRunner.run("before-run", new AbortController().signal);
    }
    const { journal, journalActivity, markActivity } = instrumentJournal(fileJournal);
    const priorEvents = await fileJournal.readValidated();
    const logicalPriorEvents = logicalRunEvents(priorEvents);
    const checkpointAnchor = latestDurableStateAnchor(logicalPriorEvents, "run.checkpoint");
    const checkpoint = await RunCheckpointLedger.open(path.join(container, "checkpoint.json"), {
        required: true,
        ...(checkpointAnchor === undefined ? {} : { expectedSha256: checkpointAnchor.sha256 }),
    });
    const contractedEvent = [...logicalPriorEvents].reverse().find((event) => event.type === "run.contracted");
    const contractedData = contractedEvent?.data;
    const contract = contractedData !== null && contractedData !== undefined
        && typeof contractedData === "object" && !Array.isArray(contractedData)
        ? normalizeContract(contractedData.contract)
        : undefined;
    const runtimeStartedAtMs = Date.now();
    const renderScanScope = () => ({ touchedPaths: versions.paths(), modifiedSinceMs: runtimeStartedAtMs });
    const completionRender = new HeadlessRenderTool(workspace);
    prewarmExecutionRuntime({ workspaceRoot: session.workspaceRoot, renderTool: completionRender });
    verifiers.push(new RenderableArtifactVerifier(workspace, contract, (relativePath, renderContext) => completionRender.execute({ path: relativePath }, renderContext), renderScanScope));
    if (contract?.creativeDirection !== undefined) {
        verifiers.push(new CreativeDirectionVerifier(createModel(options), workspace, contract, (relativePath, judgeContext) => completionRender.execute({ path: relativePath }, judgeContext), renderScanScope));
    }
    const evidenceResolver = new JournalEvidenceResolver(fileJournal);
    const plan = await PlanLedger.open(path.join(container, "plan.json"), contract === undefined ? [] : contractCriterionIds(contract), evidenceResolver, {
        required: true,
        ...(latestDurableStateAnchor(logicalPriorEvents, "update_plan") === undefined
            ? {}
            : { expectedSha256: latestDurableStateAnchor(logicalPriorEvents, "update_plan").sha256 }),
    });
    const usage = new UsageLedger(options.model);
    const delegationDepth = boundedEnvironmentInteger("VANGUARD_DELEGATION_DEPTH", 0, 0, 16);
    const delegationMaxDepth = boundedEnvironmentInteger("VANGUARD_DELEGATION_MAX_DEPTH", 1, 0, 4);
    const delegation = await DelegationCoordinator.open({
        storeFile: path.join(container, "delegations.json"),
        parentWorkspace: session.workspaceRoot,
        runner: new CliDelegateRunner({
            provider: options.provider,
            model: options.model,
            ...(options.auth === undefined ? {} : { auth: options.auth }),
            ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
            ...(options.credentialVariable === undefined ? {} : { credentialVariable: options.credentialVariable }),
            verification: options.verification,
            ...(options.publicCheck === undefined ? {} : { publicCheck: options.publicCheck }),
            protectedPaths: options.protectedPaths,
            maxDurationMs: Math.min(options.maxDurationMs, 30 * 60 * 1_000),
            commandTimeoutMs,
            maxContextBytes: options.maxContextBytes,
            maxFailedVerificationAttempts: options.maxFailedVerificationAttempts,
            disableExtensions: options.disableExtensions,
        }),
        merger: new TransactionalDelegateMerger(session.workspaceRoot),
        depth: delegationDepth,
        maxDepth: delegationMaxDepth,
        maxConcurrent: boundedEnvironmentInteger("VANGUARD_DELEGATION_CONCURRENCY", 2, 1, 8),
        maxChildren: boundedEnvironmentInteger("VANGUARD_DELEGATION_MAX_CHILDREN", 6, 1, 16),
        maxChildSteps: Math.min(options.maxSteps, 80),
        maxTotalSteps: Math.max(Math.min(options.maxSteps * 2, 240), Math.min(options.maxSteps, 80)),
        onEvent: streamPublicEvent,
    });
    const delegationTools = delegationDepth < delegationMaxDepth && options.publicCheck !== undefined
        && options.agentProfile === "coder"
        ? createDelegationTools(delegation)
        : [];
    const workingState = {
        snapshot: () => ({
            checkpoint: checkpoint.snapshot(),
            plan: plan.snapshot(),
            delegations: JSON.parse(JSON.stringify(delegation.snapshot())),
            ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
        }),
    };
    const observer = interactive
        ? combinedObserver(createStreamPresenter(markActivity), usage)
        : { delta: () => { }, usage: (value) => usage.record(value) };
    const repoMemory = new RepoMemoryStore(session.sourceRoot);
    const memoryAddendum = await repoMemory.addendum();
    const executionObserveTools = [
        new ListFilesTool(workspace),
        new SearchTextTool(workspace),
        new GlobTool(workspace),
        new ReadFileTool(workspace, 1_000_000, versions),
        new RepositoryMapTool(workspace, { includeInstructions: !options.disableExtensions }),
        new CodeIntelTool(workspace),
    ];
    const postMutationSyntaxChecker = new PostEditSyntaxChecker(new SyntaxCommandRunner(), workspace);
    const profileTools = options.agentProfile === "coder" ? [
        new RepoMemoryTool(repoMemory),
        new WriteFileTool(workspace, versions, mutationPolicy),
        new ReplaceTextTool(workspace, versions, mutationPolicy),
        new DeleteFileTool(workspace, versions, mutationPolicy),
        ...(session.direct === true ? [] : [new ReviewChangesTool(session.pristineRoot ?? session.sourceRoot, session.workspaceRoot)]),
        new HeadlessRenderTool(workspace),
        new ImageInspectionTool(workspace),
        new SyntaxCheckTool(postMutationSyntaxChecker),
        new CheckpointTool(checkpoint),
        new PlanTool(plan, evidenceResolver),
        ...delegationTools,
        ...(publicCheckTool === undefined ? [] : [publicCheckTool]),
        ...(options.exposeRawProcess ? [processTool] : []),
        ...extensionTools,
    ] : [];
    const kernel = new AgentKernel({
        model: createModel(options, observer),
        contextPolicy: new StickyContextPolicy(),
        tools: [
            new ListFilesTool(workspace),
            new SearchTextTool(workspace),
            new GlobTool(workspace),
            new ReadFileTool(workspace, 1_000_000, versions),
            new ScoutDelegateTool(createModel(options), executionObserveTools),
            new CodeIntelTool(workspace),
            new RepositoryMapTool(workspace, { includeInstructions: !options.disableExtensions }),
            ...profileTools,
        ].map(withToolHooks),
        verifiers,
        journal,
        workingState,
        ...(session.direct === true ? {} : {
            workspaceState: {
                fingerprint: (() => {
                    const fingerprintCache = new TreeSnapshotCache();
                    return async () => (await snapshotTree(session.workspaceRoot, {
                        excludedDirectories: SESSION_EXCLUDED_DIRECTORIES,
                        cache: fingerprintCache,
                    })).rootHash;
                })(),
            },
        }),
        postMutationSyntaxCheck: async (relativePath) => {
            const result = await postMutationSyntaxChecker.check(relativePath);
            return { ok: result.ok, output: result };
        },
        plan,
        completionGates: [{ blockers: () => delegation.completionBlockers() }],
        taskAddendum: `${taskAddendum(options, mutationPolicy)}${options.agentProfile === "coder" ? "" : `\n\nThis is a runtime-enforced ${options.agentProfile} subagent. Only read-only workspace tools are available; return analysis, do not attempt edits.`}${session.direct === true
            ? "\n\nThis is a direct session: you are editing the real project with no isolated copy and no baseline, and no review_changes review tool exists. Rely on targeted reads, version control, and executable checks for confidence."
            : ""}${memoryAddendum}${skillsAddendum}`,
        ...(userChannel === undefined ? {} : { userChannel }),
        options: {
            maxSteps: options.maxSteps,
            maxContextBytes: options.maxContextBytes,
            maxRepeatedAction: 3,
            maxFailedVerificationAttempts: options.maxFailedVerificationAttempts,
            interactive,
            ...(options.executionEvidence === undefined ? {} : { executionEvidence: options.executionEvidence }),
        },
    });
    return {
        kernel,
        mutationPolicyDescription: mutationPolicy.describe(),
        ...(skillsAddendum.length === 0 ? {} : { taskAugmentation: skillsAddendum }),
        journalActivity,
        usage,
        delegationSnapshot: () => JSON.parse(JSON.stringify(delegation.snapshot())),
        dispose: async () => {
            if (hookRunner !== undefined) {
                await hookRunner.run("after-run", new AbortController().signal).catch(() => { });
            }
            for (const close of extensionCloseables)
                await close().catch(() => { });
            await delegation.close();
        },
    };
}
export function taskAddendum(options, mutationPolicy) {
    const adaptive = options.adaptiveVerification === true
        ? "\nVanguard expert-mode contract: own the implementation end to end. This project did not have a recognized verification contract at launch. Establish an appropriate deterministic build/test contract as part of the work, use check_project throughout, and finish only when the automatic trusted verifier passes."
        : "";
    const instructions = options.extensionInstructions === undefined || options.extensionInstructions.length === 0
        ? ""
        : `\n\nResolved project instructions (with recorded provenance):\n${options.extensionInstructions}`;
    return `Vanguard runtime mutation policy: ${mutationPolicy.describe()}${adaptive}${instructions}`;
}
export async function runWithBudgets(options, journalActivity, controller, run) {
    const durationTimer = setTimeout(() => controller.abort(), options.maxDurationMs);
    const heartbeatTimer = setInterval(() => {
        const quietMs = Date.now() - journalActivity();
        if (quietMs >= 45_000) {
            process.stderr.write(`[Vanguard] working: provider or tool response pending (${formatDuration(quietMs)} since last event)\n`);
        }
    }, 45_000);
    heartbeatTimer.unref();
    return run(controller.signal).finally(() => {
        clearTimeout(durationTimer);
        clearInterval(heartbeatTimer);
    });
}
function instrumentJournal(fileJournal) {
    let lastProgressAt = Date.now();
    let modelTurns = 0;
    const presenter = new PublicRunEventPresenter();
    const markActivity = () => { lastProgressAt = Date.now(); };
    const journal = {
        async append(event) {
            await fileJournal.append(event);
            markActivity();
            for (const publicEvent of presenter.present(event))
                streamPublicEvent(publicEvent);
            if (event.type === "model.decided") {
                modelTurns += 1;
                const decision = event.data;
                const action = decision.kind === "tools"
                    ? (decision.calls ?? []).map((call) => call.name ?? "unknown tool").join(", ")
                    : decision.kind === "tool" ? decision.call?.name ?? "unknown tool"
                        : decision.kind === "complete" ? "completion claim"
                            : decision.kind ?? "decision";
                process.stderr.write(`[Vanguard] turn ${modelTurns}: ${action}\n`);
            }
            else if (event.type === "verification.completed") {
                const verification = event.data;
                process.stderr.write(`[Vanguard] verifier ${verification.verifier ?? "unknown"}: ${verification.passed ? "passed" : "failed"}\n`);
            }
            else if (event.type === "run.failed") {
                const failure = event.data;
                process.stderr.write(`[Vanguard] stopped: ${failure.reason ?? "run failed"}\n`);
            }
        },
    };
    return { journal, journalActivity: () => lastProgressAt, markActivity };
}
