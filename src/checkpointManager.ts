import * as vscode from 'vscode';
import { GitAiService } from './gitAiService';

export class CheckpointManager {
    private gitAiService: GitAiService;
    private outputChannel: vscode.OutputChannel;

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
    }

    public signalAiActivity() {
        this.lastAiSignalTime = Date.now();
        this.outputChannel.appendLine("[MANAGER] AI Activity Signal received.");

        // Debug Toast
        // vscode.window.showInformationMessage("Git AI: AWS Q Signal Detected!");

        // FIX: If we have a pending human checkpoint, it means a file changed recently.
        // If this signal arrives now, that change was likely caused by AI.
        // Upgrade it to an AI checkpoint immediately.
        if (this.pendingHumanTimeout) {
            this.outputChannel.appendLine("[MANAGER] Upgrading pending Human checkpoint to AWS Q due to signal.");
            vscode.window.showInformationMessage("Git AI: Upgrading Human Checkpoint -> AWS Q");
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
            vscode.window.showInformationMessage("Git AI: Checkpoint (AWS Q)");
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
