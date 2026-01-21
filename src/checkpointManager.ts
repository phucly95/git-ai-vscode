/**
 * CheckpointManager - Event-driven checkpoint manager with SYNCHRONOUS AI detection.
 * 
 * Key Design Principles:
 * 1. NO TIMEOUTS for checkpoint type determination
 * 2. SYNCHRONOUS log check at moment of file save for deterministic AI detection
 * 3. AI signals from polling also mark pending checkpoints (belt-and-suspenders)
 * 4. Checkpoint execution is serialized with a lock to prevent race conditions
 * 
 * Flow:
 * 1. FileSystemWatcher fires → handleFileChange() → record pending checkpoint
 * 2. AI signal arrives (optional) → signalAiActivity() → mark pending as AI
 * 3. File save event fires → handleFileSave() → SYNCHRONOUS log check → determine type and execute
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { GitAiService, CommitStats, RecentCommitsData } from './gitAiService';
import {
    AIProvider,
    AISignalEvent,
    PendingCheckpoint,
    shouldIgnoreFile
} from './types';
import { ProviderRegistry } from './providers';

export class CheckpointManager implements vscode.Disposable {
    private gitAiService: GitAiService;
    private providerRegistry: ProviderRegistry | null = null;
    private outputChannel: vscode.OutputChannel;
    private statusBarItem: vscode.StatusBarItem;

    /**
     * Pending checkpoints by file path.
     * Key: absolute file path
     * Value: PendingCheckpoint object
     */
    private pendingCheckpoints = new Map<string, PendingCheckpoint>();

    /**
     * Promise chain for serializing checkpoint execution.
     * Prevents race conditions when multiple checkpoints try to execute simultaneously.
     */
    private checkpointLock = Promise.resolve();

    /**
     * Interval for cleaning up stale pending checkpoints.
     */
    private cleanupInterval: NodeJS.Timeout;

    /**
     * Checkpoint counters for status display.
     */
    private aiCheckpointCount: number = 0;
    private humanCheckpointCount: number = 0;

    /**
     * Last commit stats for status bar display.
     */
    private lastCommitStats: RecentCommitsData | null = null;
    private disposables: vscode.Disposable[] = [];

    // Configuration constants
    private readonly MAX_PENDING_AGE_MS = 60000; // 60 seconds max age for pending checkpoints
    private readonly RAPID_CHANGE_DEBOUNCE_MS = 100; // Debounce rapid changes to same file
    private readonly CLEANUP_INTERVAL_MS = 10000; // Clean up every 10 seconds
    private readonly AI_CHECKPOINT_GRACE_MS = 500; // Grace period after AI checkpoint (FileSystemWatcher duplicates < 200ms)
    /**
     * Track files that recently had AI checkpoints to prevent duplicate events.
     * Key: file path, Value: timestamp of AI checkpoint
     */
    private recentAiCheckpoints = new Map<string, number>();


    constructor(gitAiService: GitAiService) {
        this.gitAiService = gitAiService;
        this.outputChannel = vscode.window.createOutputChannel('Git AI Checkpoint Manager');
        this.outputChannel.appendLine('[MANAGER] CheckpointManager initialized (synchronous detection mode)');

        // Initialize Status Bar
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.statusBarItem.command = 'gitAi.statusBarMenu';
        this.disposables.push(this.statusBarItem);

        // Initial Load
        this.updateLastCommitStats();
        this.statusBarItem.show();

        // Register Watchers for Git & Attribution Updates
        this.registerGitWatchers();

        // Periodic cleanup of stale pending checkpoints
        this.cleanupInterval = setInterval(() => {
            this.cleanupStalePendingCheckpoints();
        }, this.CLEANUP_INTERVAL_MS);
    }

    /**
     * Set the provider registry for synchronous AI signal detection.
     * Must be called after construction.
     */
    setProviderRegistry(registry: ProviderRegistry): void {
        this.providerRegistry = registry;
        this.outputChannel.appendLine('[MANAGER] Provider registry connected');
    }

    /**
     * Dispose all resources.
     */
    dispose(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }
        this.disposables.forEach(d => d.dispose());
        this.outputChannel.dispose();
    }

    /**
     * Handle file change event from FileSystemWatcher.
     * Creates a pending checkpoint that waits for either:
     * - AI signal (becomes AI checkpoint)
     * - File save (becomes Human checkpoint if no AI signal)
     */
    public handleFileChange(uri: vscode.Uri): void {
        if (uri.scheme !== 'file') return;
        const filePath = uri.fsPath;

        // Ignore system files and folders
        if (shouldIgnoreFile(filePath)) {
            return;
        }

        const now = Date.now();

        // GRACE PERIOD: Skip file changes that occur shortly after an AI checkpoint for the same file
        // This prevents duplicate events from FileSystemWatcher being classified as human
        const lastAiCheckpointTime = this.recentAiCheckpoints.get(filePath);
        if (lastAiCheckpointTime && (now - lastAiCheckpointTime) < this.AI_CHECKPOINT_GRACE_MS) {
            this.outputChannel.appendLine(
                `[MANAGER] Skipping file change (in AI grace period): ${path.basename(filePath)}`
            );
            return;
        }

        const existing = this.pendingCheckpoints.get(filePath);

        // Debounce rapid changes to the same file
        if (existing && (now - existing.changeTimestamp) < this.RAPID_CHANGE_DEBOUNCE_MS) {
            existing.changeTimestamp = now; // Update timestamp but don't create new pending
            return;
        }

        // SYNCHRONOUS CHECK: Is there an AI signal in the log right now?
        // This is the most deterministic approach - check log at the exact moment of file change
        const isAiEdit = this.providerRegistry?.hasAISignalForChange(now) ?? false;

        if (isAiEdit) {
            // AI edit detected synchronously - create and execute checkpoint immediately
            this.outputChannel.appendLine(
                `[MANAGER] AI signal detected (synchronous), executing checkpoint: ${path.basename(filePath)}`
            );

            // Record this AI checkpoint for grace period tracking
            this.recentAiCheckpoints.set(filePath, now);

            const pending: PendingCheckpoint = {
                filePath,
                changeTimestamp: now,
                aiSignalReceived: true,
                fileSaved: true, // AWS Q writes directly to disk
                provider: 'aws-q',
                sessionId: undefined
            };

            this.executeCheckpoint(pending);
        } else {
            // No AI signal - this is a human edit in progress
            // Create pending checkpoint, wait for save event
            const pending: PendingCheckpoint = {
                filePath,
                changeTimestamp: now,
                aiSignalReceived: false,
                fileSaved: false,
                provider: undefined,
                sessionId: undefined
            };

            this.pendingCheckpoints.set(filePath, pending);
            this.outputChannel.appendLine(`[MANAGER] File change recorded (human): ${path.basename(filePath)}`);
        }
    }

    /**
     * Handle AI signal from provider (from log polling).
     * Match signal to pending checkpoints and execute them as AI.
     */
    public signalAiActivity(event: AISignalEvent): void {
        this.outputChannel.appendLine(
            `[MANAGER] AI signal received from ${event.provider} (pending: ${this.pendingCheckpoints.size})`
        );

        // If specific file paths are provided, only mark those
        if (event.filePaths && event.filePaths.length > 0) {
            for (const filePath of event.filePaths) {
                const pending = this.pendingCheckpoints.get(filePath);
                if (pending && !pending.aiSignalReceived) {
                    this.markAsAi(pending, event);
                }
            }
        } else {
            // No specific paths - mark all RECENT pending checkpoints as AI
            // "Recent" means within a small time window to avoid false positives
            const now = Date.now();
            const RECENT_THRESHOLD_MS = 5000; // 5 seconds

            for (const pending of this.pendingCheckpoints.values()) {
                if (!pending.aiSignalReceived && (now - pending.changeTimestamp) < RECENT_THRESHOLD_MS) {
                    this.markAsAi(pending, event);
                }
            }
        }

        this.renderStatus('$(broadcast) Signal!');
    }

    /**
     * Mark a pending checkpoint as AI-originated and execute immediately.
     * 
     * AWS Q writes directly to disk (workspace.fs.writeFile), which does NOT 
     * trigger onDidSaveTextDocument. So we must execute checkpoint when we 
     * receive the AI signal, not wait for save event.
     */
    private markAsAi(pending: PendingCheckpoint, event: AISignalEvent): void {
        pending.aiSignalReceived = true;
        pending.provider = event.provider;
        pending.sessionId = event.sessionId;
        pending.model = event.model;

        // Record grace period to prevent duplicate classification
        this.recentAiCheckpoints.set(pending.filePath, Date.now());

        // Execute AI checkpoint immediately - AWS Q doesn't trigger save event
        this.outputChannel.appendLine(
            `[MANAGER] AI signal matched to file change, executing immediately: ${path.basename(pending.filePath)}`
        );
        this.executeCheckpoint(pending);
    }

    /**
     * Handle file save event.
     * This is the trigger to finalize checkpoint type determination.
     * 
     * DETERMINISTIC: We check the log file SYNCHRONOUSLY at this moment
     * to detect if there was recent AI activity. No timeouts or polling dependencies.
     */
    public handleFileSave(filePath: string): void {
        // Ignore system files
        if (shouldIgnoreFile(filePath)) {
            return;
        }

        const now = Date.now();

        // GRACE PERIOD: Skip saves that occur shortly after an AI checkpoint
        const lastAiCheckpointTime = this.recentAiCheckpoints.get(filePath);
        if (lastAiCheckpointTime && (now - lastAiCheckpointTime) < this.AI_CHECKPOINT_GRACE_MS) {
            this.outputChannel.appendLine(
                `[MANAGER] Skipping file save (in AI grace period): ${path.basename(filePath)}`
            );
            return;
        }

        let pending = this.pendingCheckpoints.get(filePath);

        if (!pending) {
            // File saved without prior change event (e.g., new file or external save)
            pending = {
                filePath,
                changeTimestamp: now,
                aiSignalReceived: false,
                fileSaved: true,
                provider: undefined,
                sessionId: undefined
            };
            this.pendingCheckpoints.set(filePath, pending);
        } else {
            pending.fileSaved = true;
        }

        // DETERMINISTIC CHECK 1: Did polling already detect AI signal?
        if (pending.aiSignalReceived) {
            this.outputChannel.appendLine(
                `[MANAGER] AI signal already received (from polling): ${path.basename(filePath)}`
            );
            this.executeCheckpoint(pending);
            return;
        }

        // DETERMINISTIC CHECK 2: Synchronously read log file for AI signals
        // that correlate with this specific file change (within 500ms tolerance)
        if (this.providerRegistry) {
            const hasCorrelatingSignal = this.providerRegistry.hasAISignalForChange(pending.changeTimestamp);
            if (hasCorrelatingSignal) {
                this.outputChannel.appendLine(
                    `[MANAGER] AI signal detected (synchronous check, correlated with change): ${path.basename(filePath)}`
                );
                pending.aiSignalReceived = true;
                pending.provider = 'aws-q'; // Default to AWS Q for now
                this.executeCheckpoint(pending);
                return;
            }
        }

        // No AI signal detected - this is a human edit
        this.outputChannel.appendLine(
            `[MANAGER] No AI signal detected, treating as human: ${path.basename(filePath)}`
        );
        this.executeCheckpoint(pending);
    }


    /**
     * Execute checkpoint with proper locking to prevent race conditions.
     */
    private async executeCheckpoint(pending: PendingCheckpoint): Promise<void> {
        // Remove from pending immediately to prevent double execution
        this.pendingCheckpoints.delete(pending.filePath);

        // Serialize checkpoint execution using promise chain
        this.checkpointLock = this.checkpointLock
            .then(async () => {
                if (pending.aiSignalReceived) {
                    await this.executeAiCheckpoint(pending);
                } else {
                    await this.executeHumanCheckpoint(pending);
                }
            })
            .catch(e => {
                this.outputChannel.appendLine(`[MANAGER] Checkpoint execution error: ${e}`);
                console.error('[git-ai] Checkpoint error:', e);
            });

        await this.checkpointLock;
    }

    /**
     * Execute an AI (AWS Q / Kiro) checkpoint.
     */
    private async executeAiCheckpoint(pending: PendingCheckpoint): Promise<void> {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(pending.filePath));
        if (!workspaceFolder) {
            this.outputChannel.appendLine(`[MANAGER] No workspace folder for: ${pending.filePath}`);
            return;
        }

        const repoDir = workspaceFolder.uri.fsPath;

        this.outputChannel.appendLine(
            `[MANAGER] Executing AI checkpoint: ${path.basename(pending.filePath)} ` +
            `(provider: ${pending.provider}, session: ${pending.sessionId?.substring(0, 8) ?? 'unknown'})`
        );

        try {
            await this.gitAiService.checkpointAwsQ(repoDir, pending.filePath);
            this.aiCheckpointCount++;
            this.renderStatus('$(check) AI Saved');
            await this.updateLastCommitStats();
        } catch (e) {
            this.outputChannel.appendLine(`[MANAGER] AI checkpoint failed: ${e}`);
            console.error('[git-ai] AI checkpoint failed:', e);
        }
    }

    /**
     * Execute a human checkpoint.
     */
    private async executeHumanCheckpoint(pending: PendingCheckpoint): Promise<void> {
        this.outputChannel.appendLine(
            `[MANAGER] Executing Human checkpoint: ${path.basename(pending.filePath)}`
        );

        try {
            await this.gitAiService.checkpointHuman(pending.filePath);
            this.humanCheckpointCount++;
            this.renderStatus('$(person) Human Saved');
            await this.updateLastCommitStats();
        } catch (e) {
            this.outputChannel.appendLine(`[MANAGER] Human checkpoint failed: ${e}`);
            console.error('[git-ai] Human checkpoint failed:', e);
        }
    }

    /**
     * Clean up pending checkpoints that have been waiting too long.
     */
    private cleanupStalePendingCheckpoints(): void {
        const now = Date.now();
        const staleEntries: string[] = [];

        for (const [filePath, pending] of this.pendingCheckpoints) {
            if (now - pending.changeTimestamp > this.MAX_PENDING_AGE_MS) {
                staleEntries.push(filePath);
            }
        }

        for (const filePath of staleEntries) {
            this.outputChannel.appendLine(`[MANAGER] Cleaning stale pending: ${path.basename(filePath)}`);
            this.pendingCheckpoints.delete(filePath);
        }

        // Clean expired grace period entries (memory leak fix)
        for (const [filePath, timestamp] of this.recentAiCheckpoints) {
            if (now - timestamp > this.AI_CHECKPOINT_GRACE_MS * 2) {
                this.recentAiCheckpoints.delete(filePath);
            }
        }
    }

    // ==================== Status Bar and Stats ====================

    private registerGitWatchers(): void {
        const gitWatcher = vscode.workspace.createFileSystemWatcher('**/.git/{HEAD,logs/HEAD}');
        const gitAiWatcher = vscode.workspace.createFileSystemWatcher('**/.git-ai/**/*');

        this.disposables.push(gitWatcher);
        this.disposables.push(gitAiWatcher);

        const refreshHandler = () => {
            setTimeout(() => this.updateLastCommitStats(), 500);
        };

        this.disposables.push(gitWatcher.onDidChange(refreshHandler));
        this.disposables.push(gitWatcher.onDidCreate(refreshHandler));
        this.disposables.push(gitAiWatcher.onDidChange(refreshHandler));
        this.disposables.push(gitAiWatcher.onDidCreate(refreshHandler));
        this.disposables.push(gitAiWatcher.onDidDelete(refreshHandler));
    }

    public async updateLastCommitStats(): Promise<void> {
        try {
            const config = vscode.workspace.getConfiguration('gitAi');
            const depth = config.get<number>('statusBarCommitDepth', 1);
            const stats = await this.gitAiService.getRecentStats(depth);
            this.lastCommitStats = stats;
            this.renderStatus();
        } catch (e) {
            console.error('[git-ai] Failed to update stats:', e);
        }
    }

    public updateStatus(text: string, icon: string = 'eye', tooltip: string = ''): void {
        if (text.includes('Signal')) {
            this.renderStatus('$(broadcast) Signal!');
        } else if (text.includes('Watching')) {
            this.renderStatus('$(eye) Watching');
        } else {
            this.renderStatus(text);
        }
    }

    private renderStatus(transientMsg?: string): void {
        if (transientMsg) {
            this.statusBarItem.text = `Git AI: ${transientMsg}`;
            setTimeout(() => this.renderStatus(), 3000);
            return;
        }

        if (!this.lastCommitStats) {
            this.statusBarItem.text = 'Git AI: $(robot)';
            this.statusBarItem.tooltip = 'Git AI: Ready (No commit stats available)';
            return;
        }

        const data = this.lastCommitStats;
        const stats = data.aggregated;
        const total = stats.human_additions + stats.mixed_additions + stats.ai_additions + stats.ai_accepted;

        if (total === 0) {
            this.statusBarItem.text = 'Git AI: $(robot) 0%';
            this.statusBarItem.tooltip = 'Last Commit: No additive changes detected.';
            return;
        }

        const aiPct = Math.round(((stats.ai_additions + stats.ai_accepted) / total) * 100);
        const mixedPct = Math.round((stats.mixed_additions / total) * 100);
        const humanPct = Math.round((stats.human_additions / total) * 100);

        this.statusBarItem.text = `Git AI: $(robot) ${aiPct}%  $(group-by-ref-type) ${mixedPct}%  $(person) ${humanPct}%`;

        // Build tooltip
        const md = new vscode.MarkdownString();
        md.isTrusted = true;
        md.supportHtml = true;

        const config = vscode.workspace.getConfiguration('gitAi');
        const depth = config.get<number>('statusBarCommitDepth', 1);
        const scopeText = depth > 1 ? `Last ${depth} Commits` : 'Last Commit';

        md.appendMarkdown(`### Authorship Stats (${scopeText})\n\n`);
        md.appendMarkdown(`| No | Commit | Message | Author | AI | Mix | Human | % (A/M/H) |\n`);
        md.appendMarkdown(`| -- | ------ | ------- | ------ | -- | --- | ----- | --------- |\n`);

        const MAX_ROWS = 15;
        const visibleCommits = data.commits.slice(0, MAX_ROWS);
        const hiddenCount = data.commits.length - MAX_ROWS;

        visibleCommits.forEach((c, i) => {
            const commitTotal = c.human_additions + c.mixed_additions + c.ai_additions + c.ai_accepted;
            let cAi = 0, cMix = 0, cHuman = 0;

            if (commitTotal > 0) {
                cAi = Math.round(((c.ai_additions + c.ai_accepted) / commitTotal) * 100);
                cMix = Math.round((c.mixed_additions / commitTotal) * 100);
                cHuman = Math.round((c.human_additions / commitTotal) * 100);
            }

            const shortMsg = c.subject.length > 25 ? c.subject.substring(0, 24) + '...' : c.subject;
            const shortAuth = c.author.length > 15 ? c.author.substring(0, 14) + '...' : c.author;
            const safeMsg = shortMsg.replace(/\|/g, '\\|').replace(/ /g, '&nbsp;');
            const safeAuth = shortAuth.replace(/\|/g, '\\|').replace(/ /g, '&nbsp;');

            md.appendMarkdown(`| ${i + 1} | ${c.shortHash} | ${safeMsg} | ${safeAuth} | ${c.ai_additions + c.ai_accepted} | ${c.mixed_additions} | ${c.human_additions} | ${cAi}/${cMix}/${cHuman} |\n`);
        });

        if (hiddenCount > 0) {
            md.appendMarkdown(`| ... | ... | *(${hiddenCount} more commits)* | ... | ... | ... | ... | ... |\n`);
        }

        md.appendMarkdown(`| **Sum** | | | | **${stats.ai_additions + stats.ai_accepted}** | **${stats.mixed_additions}** | **${stats.human_additions}** | **${aiPct}/${mixedPct}/${humanPct}** |\n\n`);
        md.appendMarkdown(`---\n`);
        md.appendMarkdown(`**Total Additions**: ${total} lines\n`);
        md.appendMarkdown(`**Pending Checkpoints**: ${this.pendingCheckpoints.size}\n`);

        this.statusBarItem.tooltip = md;
    }

    public async openFullStats(): Promise<void> {
        if (!this.lastCommitStats) {
            vscode.window.showInformationMessage('Git AI: No stats available to report.');
            return;
        }

        const data = this.lastCommitStats;
        const stats = data.aggregated;
        const total = stats.human_additions + stats.mixed_additions + stats.ai_additions + stats.ai_accepted;

        const config = vscode.workspace.getConfiguration('gitAi');
        const depth = config.get<number>('statusBarCommitDepth', 1);
        const scopeText = depth > 1 ? `Last ${depth} Commits` : 'Last Commit';

        const aiPct = total > 0 ? Math.round(((stats.ai_additions + stats.ai_accepted) / total) * 100) : 0;
        const mixedPct = total > 0 ? Math.round((stats.mixed_additions / total) * 100) : 0;
        const humanPct = total > 0 ? Math.round((stats.human_additions / total) * 100) : 0;

        let content = `# Git AI Authorship Report\n\n`;
        content += `**Scope:** ${scopeText}\n`;
        content += `**Generated:** ${new Date().toLocaleString()}\n\n`;

        content += `## Summary\n`;
        content += `- **Total Lines Added:** ${total}\n`;
        content += `- **AI Generated:** ${stats.ai_additions + stats.ai_accepted} (${aiPct}%)\n`;
        content += `- **Mixed:** ${stats.mixed_additions} (${mixedPct}%)\n`;
        content += `- **Human:** ${stats.human_additions} (${humanPct}%)\n\n`;

        content += `## Detailed Commits\n\n`;
        content += `| No | Commit | Message | Author | AI | Mix | Human | % (A/M/H) |\n`;
        content += `| -- | ------ | ------- | ------ | -- | --- | ----- | --------- |\n`;

        data.commits.forEach((c, i) => {
            const cTotal = c.human_additions + c.mixed_additions + c.ai_additions + c.ai_accepted;
            let cAi = 0, cMix = 0, cHuman = 0;
            if (cTotal > 0) {
                cAi = Math.round(((c.ai_additions + c.ai_accepted) / cTotal) * 100);
                cMix = Math.round((c.mixed_additions / cTotal) * 100);
                cHuman = Math.round((c.human_additions / cTotal) * 100);
            }

            content += `| ${i + 1} | ${c.shortHash} | ${c.subject} | ${c.author} | ${c.ai_additions + c.ai_accepted} | ${c.mixed_additions} | ${c.human_additions} | ${cAi}/${cMix}/${cHuman} |\n`;
        });

        const doc = await vscode.workspace.openTextDocument({
            content: content,
            language: 'markdown'
        });

        await vscode.window.showTextDocument(doc);
    }

    /**
     * Get debug information about the checkpoint manager state.
     */
    public getDebugInfo(): string {
        return JSON.stringify({
            pendingCheckpoints: this.pendingCheckpoints.size,
            aiCheckpointCount: this.aiCheckpointCount,
            humanCheckpointCount: this.humanCheckpointCount,
            pending: Array.from(this.pendingCheckpoints.entries()).map(([path, p]) => ({
                path: path.split('/').pop(),
                aiSignalReceived: p.aiSignalReceived,
                fileSaved: p.fileSaved,
                age: Date.now() - p.changeTimestamp
            }))
        }, null, 2);
    }
}
