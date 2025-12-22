
import * as vscode from 'vscode';
import { GitAiService } from './gitAiService';
import { CheckpointManager } from './checkpointManager';
import { AwsQLogWatcher } from './awsQLogWatcher';

let checkpointManager: CheckpointManager;

export function activate(context: vscode.ExtensionContext) {
    console.log('Git AI Integration is now active!');

    // Pass context to GitAiService for access to extensionPath
    const gitAiService = new GitAiService(context);
    checkpointManager = new CheckpointManager(gitAiService);

    // Initial check: if git-ai shim is not installed, prompt user (Mandatory Setup)
    // Initial check: if git-ai shim is not installed or configured, prompt user (Mandatory Setup)
    setTimeout(async () => {
        const installed = await gitAiService.isShimInstalled();
        const homeDir = require('os').homedir();
        const shimDir = require('path').join(homeDir, '.git-ai', 'bin');
        const shimPath = require('path').join(shimDir, 'git');

        // 1. Ensure Integrated Terminal uses the shim (No restart needed)
        // This applies to all new terminals created in VS Code
        const delimiter = process.platform === 'win32' ? ';' : ':';
        context.environmentVariableCollection.prepend('PATH', shimDir + delimiter);

        if (!installed) {
            try {
                // Silent Install (User Request)
                const destDir = await gitAiService.installGlobalShim();
                vscode.window.showInformationMessage(`Git AI: Global shim configured in ${destDir}`);

                // Try to configure shell rc for external terminals too
                await gitAiService.configureShellPath();
            } catch (err: any) {
                vscode.window.showErrorMessage(`Git AI Setup Failed: ${err.message}`);
                console.error(err);
            }
        } else {
            // Even if installed, ensure VS Code is configured to use it
            await gitAiService.checkAndConfigureGitPath(shimPath);

            // Also ensure shell rc is configured (for external usage)
            await gitAiService.configureShellPath();
        }
    }, 1000);

    // Register Install Command
    context.subscriptions.push(vscode.commands.registerCommand('gitAi.installCli', async () => {
        try {
            const destPath = await gitAiService.installBundledCli();
            vscode.window.showInformationMessage(`Git AI CLI installed to ${destPath}`);
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to install Git AI CLI: ${err.message}`);
        }
    }));

    // Register Shim Install Command
    context.subscriptions.push(vscode.commands.registerCommand('gitAi.installShim', async () => {
        const selection = await vscode.window.showWarningMessage(
            "This will modify your 'git' command by installing a shim in '~/.git-ai/bin'. It allows git-ai to track ownership of all your commits. Proceed?",
            "Yes, Install Shim",
            "Cancel"
        );

        if (selection !== "Yes, Install Shim") {
            return;
        }

        try {
            const destDir = await gitAiService.installGlobalShim();
            vscode.window.showInformationMessage(`Git AI Shim installed in ${destDir}. Please ensure this directory is in your PATH.`);
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to install Git AI Shim: ${err.message}`);
        }
    }));

    // Register Fix Shell Path Command
    context.subscriptions.push(vscode.commands.registerCommand('gitAi.fixShellPath', async () => {
        try {
            await gitAiService.configureShellPath();
            // If configureShellPath succeeds (or partially succeeds), it shows an info message.
            // But we can add an extra explicit one here if needed, or rely on the function's internal messaging.
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to fix shell path: ${err.message}`);
        }
    }));

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

