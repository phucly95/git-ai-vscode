import * as vscode from 'vscode';
import * as path from 'path';
import { GitAiService, CommitStats, RecentCommitsData } from './gitAiService';

export class CheckpointManager {
    private gitAiService: GitAiService;
    private outputChannel: vscode.OutputChannel;
    private statusBarItem: vscode.StatusBarItem;

    private pendingHumanTimeout: NodeJS.Timeout | null = null;
    private pendingFile: string | null = null;

    // Time when the last AI activity was detected (log/signal)
    private lastAiSignalTime: number = 0;
    private readonly AI_SIGNAL_WINDOW_MS = 10000; // Increased to 10s for debugging

    // Checkpoint Counters
    private aiCheckpointCount: number = 0;
    private humanCheckpointCount: number = 0;

    // Time when the last AI checkpoint finished.
    private lastAiCheckpointTime: number = 0;
    private readonly AI_GRACE_PERIOD_MS = 5000;

    // Configurable via 'gitAi.humanDebounceMillis'
    private get humanDebounceMs(): number {
        const config = vscode.workspace.getConfiguration('gitAi');
        return config.get<number>('humanDebounceMillis', 1500);
    }

    private get commitDepth(): number {
        const config = vscode.workspace.getConfiguration('gitAi');
        return config.get<number>('statusBarCommitDepth', 1);
    }

    private disposables: vscode.Disposable[] = [];
    private lastCommitStats: RecentCommitsData | null = null;

    constructor(gitAiService: GitAiService) {
        this.gitAiService = gitAiService;
        this.outputChannel = vscode.window.createOutputChannel("Git AI Manager");
        this.outputChannel.appendLine("CheckpointManager initialized.");

        // Initialize Status Bar
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.statusBarItem.command = "gitAi.statusBarMenu";
        this.disposables.push(this.statusBarItem);

        // Initial Load
        this.updateLastCommitStats();
        this.statusBarItem.show();

        // Register Watchers for Git & Attribution Updates
        this.registerGitWatchers();
    }

    public dispose() {
        this.disposables.forEach(d => d.dispose());
    }

    private registerGitWatchers() {
        // Watch .git/HEAD and .git/logs/HEAD for commit/branch changes
        const gitWatcher = vscode.workspace.createFileSystemWatcher('**/.git/{HEAD,logs/HEAD}');

        // Watch .git-ai/ for manual attribution updates (optional, but good for responsiveness)
        const gitAiWatcher = vscode.workspace.createFileSystemWatcher('**/.git-ai/**/*');

        this.disposables.push(gitWatcher);
        this.disposables.push(gitAiWatcher);

        const refreshHandler = () => {
            // Debounce slightly to avoid reading lock files or partial writes
            setTimeout(() => this.updateLastCommitStats(), 500);
        };

        this.disposables.push(gitWatcher.onDidChange(refreshHandler));
        this.disposables.push(gitWatcher.onDidCreate(refreshHandler));
        this.disposables.push(gitAiWatcher.onDidChange(refreshHandler));
        this.disposables.push(gitAiWatcher.onDidCreate(refreshHandler));
        this.disposables.push(gitAiWatcher.onDidDelete(refreshHandler));
    }

    public async updateLastCommitStats() {
        try {
            const depth = this.commitDepth;
            const stats = await this.gitAiService.getRecentStats(depth);
            this.lastCommitStats = stats;
            this.renderStatus();
        } catch (e) {
            console.error("Failed to update stats", e);
        }
    }

    private renderStatus(transientMsg?: string) {
        if (transientMsg) {
            this.statusBarItem.text = `Git AI: ${transientMsg}`;
            // Revert to stats after 3s
            setTimeout(() => this.renderStatus(), 3000);
            return;
        }

        if (!this.lastCommitStats) {
            // Fallback or Initial State
            this.statusBarItem.text = `Git AI: $(robot)`;
            this.statusBarItem.tooltip = "Git AI: Ready (No commit stats available)";
            return;
        }

        const data = this.lastCommitStats;
        const stats = data.aggregated;
        const total = stats.human_additions + stats.mixed_additions + stats.ai_additions + stats.ai_accepted;

        // Avoid division by zero
        if (total === 0) {
            this.statusBarItem.text = `Git AI: $(robot) 0%`;
            this.statusBarItem.tooltip = "Last Commit: No additive changes detected.";
            return;
        }

        // Calculate Percentages (Aggregated)
        const aiPct = Math.round(((stats.ai_additions + stats.ai_accepted) / total) * 100);
        const mixedPct = Math.round((stats.mixed_additions / total) * 100);
        const humanPct = Math.round((stats.human_additions / total) * 100);

        this.statusBarItem.text = `Git AI: $(robot) ${aiPct}%  $(group-by-ref-type) ${mixedPct}%  $(person) ${humanPct}%`;

        // Detailed Tooltip (Markdown Table)
        const md = new vscode.MarkdownString();
        md.isTrusted = true;
        md.supportHtml = true;

        const depth = this.commitDepth;
        const scopeText = depth > 1 ? `Last ${depth} Commits` : `Last Commit`;

        md.appendMarkdown(`### Authorship Stats (${scopeText})\n\n`);

        // Table Header
        md.appendMarkdown(`| No | Commit | Message | Author | AI | Mix | Human | % (A/M/H) |\n`);
        md.appendMarkdown(`| -- | ------ | ------- | ------ | -- | --- | ----- | --------- |\n`);

        // Table Rows
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
            // Escape pipe characters just in case
            const safeMsg = shortMsg.replace(/\|/g, '\\|');
            // Use non-breaking spaces to ensure author stays on one line
            const safeAuth = shortAuth.replace(/\|/g, '\\|').replace(/ /g, '&nbsp;');

            md.appendMarkdown(`| ${i + 1} | ${c.shortHash} | ${safeMsg} | ${safeAuth} | ${c.ai_additions + c.ai_accepted} | ${c.mixed_additions} | ${c.human_additions} | ${cAi}/${cMix}/${cHuman} |\n`);
        });

        if (hiddenCount > 0) {
            md.appendMarkdown(`| ... | ... | *(${hiddenCount} more commits)* | ... | ... | ... | ... | ... |\n`);
        }

        // Summary Row using aggregated stats
        md.appendMarkdown(`| **Sum** | | | | **${stats.ai_additions + stats.ai_accepted}** | **${stats.mixed_additions}** | **${stats.human_additions}** | **${aiPct}/${mixedPct}/${humanPct}** |\n\n`);

        md.appendMarkdown(`---\n`);
        md.appendMarkdown(`**Total Additions**: ${total} lines\n`);
        // md.appendMarkdown(`**Waiting for AI**: ${stats.time_waiting_for_ai}ms`); // Removed as per request

        this.statusBarItem.tooltip = md;
    }

    // Adapter for legacy calls (Watcher)
    public updateStatus(text: string, icon: string = "eye", tooltip: string = "") {
        if (text.includes("Signal")) {
            this.renderStatus("$(broadcast) Signal!");
        } else if (text.includes("Watching")) {
            // Don't override counters for "Watching", just log or tooltip?
            // actually, showing "Watching" at startup is nice.
            this.renderStatus("$(eye) Watching");
        } else {
            this.renderStatus(text);
        }
    }

    public signalAiActivity() {
        this.lastAiSignalTime = Date.now();
        // this.outputChannel.appendLine("[MANAGER] AI Activity Signal received.");

        this.renderStatus("$(broadcast) Signal!");

        // Debug Toast
        // vscode.window.showInformationMessage("Git AI: AWS Q Signal Detected!");

        // FIX: If we have a pending human checkpoint, it means a file changed recently.
        // If this signal arrives now, that change was likely caused by AI.
        // Upgrade it to an AI checkpoint immediately.
        if (this.pendingHumanTimeout) {
            // this.outputChannel.appendLine("[MANAGER] Upgrading pending Human checkpoint to AWS Q due to signal.");
            this.renderStatus("$(arrow-up) Upgrading...");
            clearTimeout(this.pendingHumanTimeout);
            this.pendingHumanTimeout = null;

            if (this.pendingFile) {
                this.requestAwsQCheckpoint(this.pendingFile);
            }
        }
    }

    public handleFileChange(uri: vscode.Uri) {
        if (uri.scheme !== 'file') return;

        const filePath = uri.fsPath;

        // Anti-Loop: Ignore .git, .git-ai, and other system folders
        if (filePath.includes(`${path.sep}.git${path.sep}`) || filePath.includes(`${path.sep}.git-ai${path.sep}`) || filePath.includes(`${path.sep}node_modules${path.sep}`) || filePath.includes('.DS_Store')) {
            return;
        }

        // Store probable file for race-condition handling
        this.pendingFile = filePath;

        // Strategy: Always assume Human first (Buffered).
        // If it's actually AI, the LogWatcher will fire 'signalAiActivity' shortly.
        // That signal will SEE the pending human checkpoint and UPGRADE it to AI.
        // This handles the "File Change happens before Log" race condition perfectly.

        // Exception: If we *just* had an AI signal (e.g. log came first), we can shortcut.
        const now = Date.now();
        const timeSinceAi = now - this.lastAiSignalTime;
        if (timeSinceAi < this.AI_SIGNAL_WINDOW_MS) {
            // this.outputChannel.appendLine(`[MANAGER] Pre-correlated File Change to AI (delta=${timeSinceAi}ms). Path=${filePath}`);
            this.requestAwsQCheckpoint(filePath);
        } else {
            this.requestHumanCheckpoint();
        }
    }

    /**
     * "Reactive" Strategy:
     * When a file changes on disk (FileSystemWatcher), we schedule a Human Checkpoint (buffered).
     * If an AI Signal arrives during this buffer, we CANCEL the Human Checkpoint and upgrade to AI.
     * If the buffer expires and no AI signal came, we confirm it was Human.
     */
    public requestHumanCheckpoint() {
        const now = Date.now();

        // 1. Grace Period Check (Don't double-save after AI)
        if (now - this.lastAiCheckpointTime < this.AI_GRACE_PERIOD_MS) {
            return;
        }

        // 2. Buffer/Debounce
        // We wait 'humanDebounceMs' to see if an AI signal arrives OR to group rapid valid-saves.
        if (this.pendingHumanTimeout) {
            clearTimeout(this.pendingHumanTimeout);
            this.pendingHumanTimeout = null;
        }

        this.pendingHumanTimeout = setTimeout(() => {
            // The buffer expired. No AI signal intercepted us.
            // Therefore: It is Human.
            this.executeHumanCheckpoint();
        }, this.humanDebounceMs);
    }

    public requestAwsQCheckpoint(filePath: string) {
        // Throttling: specific to preventing spam from a single "action" that touches multiple files
        if (Date.now() - this.lastAiCheckpointTime < 500) {
            return;
        }

        // this.outputChannel.appendLine("[MANAGER] AWS Q Checkpoint requested. Cancelling pending human tasks.");

        if (this.pendingHumanTimeout) {
            clearTimeout(this.pendingHumanTimeout);
            this.pendingHumanTimeout = null;
        }

        // Execute immediately
        this.executeAwsQCheckpoint(filePath);
        this.lastAiCheckpointTime = Date.now();
    }

    private executeHumanCheckpoint() {
        const now = Date.now();
        if (now - this.lastAiCheckpointTime < this.AI_GRACE_PERIOD_MS) {
            return;
        }
        // Pass the pending file (or null) to determine CWD
        this.gitAiService.checkpointHuman(this.pendingFile || undefined)
            .then(() => {
                this.humanCheckpointCount++;
                this.renderStatus();
            })
            .catch(e => console.error(e));
    }

    private executeAwsQCheckpoint(filePath: string) {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
        if (workspaceFolder) {
            this.gitAiService.checkpointAwsQ(workspaceFolder.uri.fsPath, filePath)
                .then(() => {
                    this.aiCheckpointCount++;
                    this.renderStatus("$(check) AI Saved");
                })
                .catch(e => console.error(e));
        }
    }
    public async openFullStats() {
        if (!this.lastCommitStats) {
            vscode.window.showInformationMessage("Git AI: No stats available to report.");
            return;
        }

        const data = this.lastCommitStats;
        const stats = data.aggregated;
        const total = stats.human_additions + stats.mixed_additions + stats.ai_additions + stats.ai_accepted;
        const depth = this.commitDepth;
        const scopeText = depth > 1 ? `Last ${depth} Commits` : `Last Commit`;

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

            // For the report, we don't need &nbsp; or short truncation as strictly
            // But let's keep it readable
            content += `| ${i + 1} | ${c.shortHash} | ${c.subject} | ${c.author} | ${c.ai_additions + c.ai_accepted} | ${c.mixed_additions} | ${c.human_additions} | ${cAi}/${cMix}/${cHuman} |\n`;
        });

        const doc = await vscode.workspace.openTextDocument({
            content: content,
            language: 'markdown'
        });

        await vscode.window.showTextDocument(doc);
    }
}
