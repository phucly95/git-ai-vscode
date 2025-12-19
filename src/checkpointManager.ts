import * as vscode from 'vscode';
import * as path from 'path';
import { GitAiService } from './gitAiService';

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

    constructor(gitAiService: GitAiService) {
        this.gitAiService = gitAiService;
        this.outputChannel = vscode.window.createOutputChannel("Git AI Manager");
        this.outputChannel.appendLine("CheckpointManager initialized.");

        // Initialize Status Bar
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.statusBarItem.command = "gitAi.showDebugInfo";
        this.renderStatus("Initializing...");
        this.statusBarItem.show();
    }

    private renderStatus(transientMsg?: string) {
        if (transientMsg) {
            this.statusBarItem.text = `Git AI: ${transientMsg}`;
            // Revert to counters after 3s
            setTimeout(() => this.renderStatus(), 3000);
        } else {
            this.statusBarItem.text = `Git AI: $(hubot) ${this.aiCheckpointCount}   $(edit) ${this.humanCheckpointCount}`;
        }
        this.statusBarItem.tooltip = "Git AI Integration\n$(hubot) AI Checkpoints\n$(edit) Human Checkpoints\nClick for Debug Info";
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
        this.outputChannel.appendLine("[MANAGER] AI Activity Signal received.");

        this.renderStatus("$(broadcast) Signal!");

        // Debug Toast
        // vscode.window.showInformationMessage("Git AI: AWS Q Signal Detected!");

        // FIX: If we have a pending human checkpoint, it means a file changed recently.
        // If this signal arrives now, that change was likely caused by AI.
        // Upgrade it to an AI checkpoint immediately.
        if (this.pendingHumanTimeout) {
            this.outputChannel.appendLine("[MANAGER] Upgrading pending Human checkpoint to AWS Q due to signal.");
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

        const now = Date.now();
        const timeSinceAi = now - this.lastAiSignalTime;

        // Store probable file for race-condition handling
        this.pendingFile = filePath;

        if (timeSinceAi < this.AI_SIGNAL_WINDOW_MS) {
            this.outputChannel.appendLine(`[MANAGER] Correlated File Change to AI (delta=${timeSinceAi}ms). Path=${filePath}`);
            this.requestAwsQCheckpoint(filePath);
        } else {
            this.requestHumanCheckpoint();
        }
    }

    public requestHumanCheckpoint() {
        const now = Date.now();
        // 1. Grace Period Check
        if (now - this.lastAiCheckpointTime < this.AI_GRACE_PERIOD_MS) {
            // this.outputChannel.appendLine("[MANAGER] Human checkpoint ignored (Grace Period active).");
            return;
        }

        // 2. Debounce
        if (this.pendingHumanTimeout) {
            clearTimeout(this.pendingHumanTimeout);
        }

        this.pendingHumanTimeout = setTimeout(() => {
            this.executeHumanCheckpoint();
        }, this.humanDebounceMs);
    }

    public requestAwsQCheckpoint(filePath: string) {
        // Throttling: specific to preventing spam from a single "action" that touches multiple files
        if (Date.now() - this.lastAiCheckpointTime < 500) {
            return;
        }

        this.outputChannel.appendLine("[MANAGER] AWS Q Checkpoint requested. Cancelling pending human tasks.");

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
}
