import * as vscode from 'vscode';
import { GitAiService } from './gitAiService';

export class CheckpointManager {
    private gitAiService: GitAiService;
    private outputChannel: vscode.OutputChannel;

    private pendingHumanTimeout: NodeJS.Timeout | null = null;

    // Time when the last AI activity was detected (log/signal)
    private lastAiSignalTime: number = 0;
    private readonly AI_SIGNAL_WINDOW_MS = 2000;

    // Time when the last AI checkpoint finished.
    private lastAiCheckpointTime: number = 0;
    private readonly AI_GRACE_PERIOD_MS = 5000;
    private readonly HUMAN_DEBOUNCE_MS = 1500;

    constructor(gitAiService: GitAiService) {
        this.gitAiService = gitAiService;
        this.outputChannel = vscode.window.createOutputChannel("Git AI Manager");
        this.outputChannel.appendLine("CheckpointManager initialized.");
    }

    public signalAiActivity() {
        this.lastAiSignalTime = Date.now();
        this.outputChannel.appendLine("[MANAGER] AI Activity Signal received.");
    }

    public handleFileChange(document: vscode.TextDocument) {
        if (document.uri.scheme !== 'file') return;

        const filePath = document.uri.fsPath;
        const now = Date.now();
        const timeSinceAi = now - this.lastAiSignalTime;

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
        }, this.HUMAN_DEBOUNCE_MS);
    }

    public requestAwsQCheckpoint(filePath: string) {
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
        this.gitAiService.checkpointHuman();
    }

    private executeAwsQCheckpoint(filePath: string) {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
        if (workspaceFolder) {
            this.gitAiService.checkpointAwsQ(workspaceFolder.uri.fsPath, filePath);
        }
    }
}
