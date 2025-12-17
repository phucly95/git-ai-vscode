
import * as vscode from 'vscode';
import { GitAiService } from './gitAiService';
import { CheckpointManager } from './checkpointManager';
import { AwsQLogWatcher } from './awsQLogWatcher';

let checkpointManager: CheckpointManager;

export function activate(context: vscode.ExtensionContext) {
    console.log('Git AI Integration is now active!');

    const gitAiService = new GitAiService();
    checkpointManager = new CheckpointManager(gitAiService);

    // Listen for file changes
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((document) => {
        checkpointManager.handleFileChange(document);
    }));

    // Also listen for content changes (debounced by manager) if you want granular changes effectively
    // But strictly speaking, git usually checkpoints on save or significant pause.
    // For now, let's trigger on Save and maybe onDidChangeTextDocument if keypresses matter.
    // In WebStorm we used BulkFileListener -> (ContentChange, Create, Move).
    // VS Code onDidChangeTextDocument triggers on every keystroke. Using it with Debounce is fine.
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.scheme === 'file') {
            checkpointManager.handleFileChange(event.document);
        }
    }));

    // Initialize AWS Q Log Watcher
    const logWatcher = new AwsQLogWatcher(checkpointManager);
    context.subscriptions.push(vscode.Disposable.from({ dispose: () => logWatcher.dispose() }));
}

export function deactivate() { }

