import * as vscode from 'vscode';
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

    // Time when the last AI checkpoint finished.
    private lastAiCheckpointTime: number = 0;
    private readonly AI_GRACE_PERIOD_MS = 5000;
    private readonly HUMAN_DEBOUNCE_MS = 1500;

    constructor(gitAiService: GitAiService) {
        this.gitAiService = gitAiService;
        this.outputChannel = vscode.window.createOutputChannel("Git AI Manager");
        this.outputChannel.appendLine("CheckpointManager initialized.");

        // Initialize Status Bar
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.statusBarItem.command = "gitAi.showDebugInfo";
        this.updateStatus("Git AI: Initializing...", "sync~spin");
        this.statusBarItem.show();
    }

    public updateStatus(text: string, icon: string = "eye", tooltip: string = "") {
        this.statusBarItem.text = `$(${icon}) ${text}`;
        this.statusBarItem.tooltip = tooltip || text;

        // Reset to default after 5 seconds if it's an activity signal
        if (text.includes("Signal") || text.includes("Checkpoint")) {
            setTimeout(() => {
                this.updateStatus("Git AI: Watching", "eye");
            }, 5000);
        }
    }

    public signalAiActivity() {
        this.lastAiSignalTime = Date.now();
        this.outputChannel.appendLine("[MANAGER] AI Activity Signal received.");

        this.updateStatus("Git AI: AWS Q Signal!", "hubot");

        // Debug Toast
        // vscode.window.showInformationMessage("Git AI: AWS Q Signal Detected!");

        // FIX: If we have a pending human checkpoint, it means a file changed recently.
        // If this signal arrives now, that change was likely caused by AI.
        // Upgrade it to an AI checkpoint immediately.
        if (this.pendingHumanTimeout) {
            this.outputChannel.appendLine("[MANAGER] Upgrading pending Human checkpoint to AWS Q due to signal.");
            this.updateStatus("Git AI: Upgrading to AWS Q", "arrow-up");
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
        const now = Date.now();
        const timeSinceAi = now - this.lastAiSignalTime;

        // Store probable file for race-condition handling
        this.pendingFile = filePath;

        if (timeSinceAi < this.AI_SIGNAL_WINDOW_MS) {
            this.outputChannel.appendLine(`[MANAGER] Correlated File Change to AI (delta=${timeSinceAi}ms). Path=${filePath}`);
            this.updateStatus("Git AI: Checkpoint (AWS Q)", "check");
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
