import * as vscode from 'vscode';
import { CheckpointManager } from './checkpointManager';

export class AwsQDetector {
    private checkpointManager: CheckpointManager;
    private outputChannel: vscode.OutputChannel;

    constructor(checkpointManager: CheckpointManager) {
        this.checkpointManager = checkpointManager;
        this.outputChannel = vscode.window.createOutputChannel("Git AI Probe");
        this.probeAwsExtension();
    }

    private probeAwsExtension() {
        const awsExtId = 'amazonwebservices.aws-toolkit-vscode';
        const ext = vscode.extensions.getExtension(awsExtId);

        if (ext) {
            this.outputChannel.appendLine(`[PROBE] Found AWS Toolkit extension: ${ext.id} (Version: ${ext.packageJSON.version})`);
            if (ext.isActive) {
                this.outputChannel.appendLine("[PROBE] AWS Toolkit is ACTIVE.");
            } else {
                this.outputChannel.appendLine("[PROBE] AWS Toolkit is INSTALLED but NOT ACTIVE.");
            }
        } else {
            this.outputChannel.appendLine("[PROBE] AWS Toolkit extension NOT found.");
        }

        // List all extensions to see if there are others like "Amazon Q"
        vscode.extensions.all.forEach(e => {
            if (e.id.toLowerCase().includes('amazon') || e.id.toLowerCase().includes('aws')) {
                this.outputChannel.appendLine(`[PROBE] Detected AWS-related extension: ${e.id}`);
            }
        });
    }

    // This method would be hooked into extension.ts listeners if we had a specific signal
    public checkPotentialAiActivity(event: vscode.TextDocumentChangeEvent) {
        // Placeholder for heuristic detection
        // e.g., rapid large insertions
    }
}
