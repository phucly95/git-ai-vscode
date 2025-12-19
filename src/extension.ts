
import * as vscode from 'vscode';
import { GitAiService } from './gitAiService';
import { CheckpointManager } from './checkpointManager';
import { AwsQLogWatcher } from './awsQLogWatcher';

let checkpointManager: CheckpointManager;

export function activate(context: vscode.ExtensionContext) {
    console.log('Git AI Integration is now active!');

    const gitAiService = new GitAiService();
    checkpointManager = new CheckpointManager(gitAiService);

    // Listen for ALL file changes (Closed files / Background agents / Terminal commands)
    // We rely on FileSystemWatcher effectively because it tracks actual disk writes.
    // This covers: Save, Paste (Save), CP, MV, External Tools, and AWS Q background writes.
    const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*');
    context.subscriptions.push(fileWatcher.onDidChange(uri => checkpointManager.handleFileChange(uri)));
    context.subscriptions.push(fileWatcher.onDidCreate(uri => checkpointManager.handleFileChange(uri)));
    context.subscriptions.push(fileWatcher.onDidDelete(uri => checkpointManager.handleFileChange(uri)));
    context.subscriptions.push(fileWatcher);

    // Initialize AWS Q Log Watcher
    const logWatcher = new AwsQLogWatcher(checkpointManager);
    context.subscriptions.push(vscode.Disposable.from({ dispose: () => logWatcher.dispose() }));

    // Debug Command
    context.subscriptions.push(vscode.commands.registerCommand('gitAi.testSignal', () => {
        vscode.window.showInformationMessage("Git AI: Manually Triggering AI Signal...");
        checkpointManager.signalAiActivity();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('gitAi.showDebugInfo', () => {
        const info = logWatcher.getDebugInfo();
        vscode.window.showInformationMessage(info);
    }));
}

export function deactivate() { }

