/**
 * Git AI VS Code Extension - Main Entry Point
 * 
 * This extension tracks AI-generated code from AWS Q (and future providers like Kiro)
 * by watching log files and correlating file changes with AI activity signals.
 * 
 * Architecture:
 * - ProviderRegistry: Manages AI provider detection and signal emission
 * - CheckpointManager: Event-driven checkpoint creation (no timeouts)
 * - GitAiService: Interfaces with git-ai CLI
 */

import * as vscode from 'vscode';
import { GitAiService } from './gitAiService';
import { CheckpointManager } from './checkpointManager';
import { ProviderRegistry } from './providers';
import { AISignalEvent } from './types';

let checkpointManager: CheckpointManager;
let providerRegistry: ProviderRegistry;

export function activate(context: vscode.ExtensionContext) {
    console.log('[git-ai] Extension activated');

    // Initialize services
    const gitAiService = new GitAiService(context);
    checkpointManager = new CheckpointManager(gitAiService);
    providerRegistry = new ProviderRegistry();

    // Wire up CheckpointManager ↔ ProviderRegistry for synchronous detection
    checkpointManager.setProviderRegistry(providerRegistry);

    // Wire up signal handler: Provider signals → Checkpoint Manager (for polling)
    providerRegistry.setSignalHandler((event: AISignalEvent) => {
        checkpointManager.signalAiActivity(event);
    });

    // Start all installed providers
    providerRegistry.startAll();

    // ==================== Event Handlers ====================

    // Listen for file changes (FileSystemWatcher)
    const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*');
    context.subscriptions.push(
        fileWatcher.onDidChange(uri => checkpointManager.handleFileChange(uri))
    );
    context.subscriptions.push(
        fileWatcher.onDidCreate(uri => checkpointManager.handleFileChange(uri))
    );
    context.subscriptions.push(
        fileWatcher.onDidDelete(uri => checkpointManager.handleFileChange(uri))
    );
    context.subscriptions.push(fileWatcher);

    // Listen for file save events - THIS IS THE KEY TRIGGER for checkpoint finalization
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(doc => {
            checkpointManager.handleFileSave(doc.uri.fsPath);
        })
    );

    // ==================== Initial Setup ====================

    // Initial check: if git-ai shim is not installed, prompt user
    setTimeout(async () => {
        const installed = await gitAiService.isShimInstalled();
        const homeDir = require('os').homedir();
        const shimDir = require('path').join(homeDir, '.git-ai', 'bin');
        const shimPath = require('path').join(shimDir, 'git');

        // Ensure Integrated Terminal uses the shim
        const delimiter = process.platform === 'win32' ? ';' : ':';
        context.environmentVariableCollection.prepend('PATH', shimDir + delimiter);

        if (!installed) {
            try {
                // Silent Install
                const destDir = await gitAiService.installGlobalShim();
                vscode.window.showInformationMessage(`Git AI: Global shim configured in ${destDir}`);
                await gitAiService.configureShellPath();
            } catch (err: any) {
                vscode.window.showErrorMessage(`Git AI Setup Failed: ${err.message}`);
                console.error('[git-ai] Setup error:', err);
            }
        } else {
            await gitAiService.checkAndConfigureGitPath(shimPath);
            await gitAiService.configureShellPath();
        }
    }, 1000);

    // ==================== Commands ====================

    // Install CLI command
    context.subscriptions.push(
        vscode.commands.registerCommand('gitAi.installCli', async () => {
            try {
                const destPath = await gitAiService.installBundledCli();
                vscode.window.showInformationMessage(`Git AI CLI installed to ${destPath}`);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to install Git AI CLI: ${err.message}`);
            }
        })
    );

    // Install Shim command
    context.subscriptions.push(
        vscode.commands.registerCommand('gitAi.installShim', async () => {
            const selection = await vscode.window.showWarningMessage(
                "This will modify your 'git' command by installing a shim in '~/.git-ai/bin'. Proceed?",
                "Yes, Install Shim",
                "Cancel"
            );

            if (selection !== "Yes, Install Shim") {
                return;
            }

            try {
                const destDir = await gitAiService.installGlobalShim();
                vscode.window.showInformationMessage(
                    `Git AI Shim installed in ${destDir}. Please ensure this directory is in your PATH.`
                );
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to install Git AI Shim: ${err.message}`);
            }
        })
    );

    // Fix Shell Path command
    context.subscriptions.push(
        vscode.commands.registerCommand('gitAi.fixShellPath', async () => {
            try {
                await gitAiService.configureShellPath();
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to fix shell path: ${err.message}`);
            }
        })
    );

    // Test Signal command (for debugging)
    context.subscriptions.push(
        vscode.commands.registerCommand('gitAi.testSignal', () => {
            vscode.window.showInformationMessage("Git AI: Manually Triggering AI Signal...");
            checkpointManager.signalAiActivity({
                provider: 'aws-q',
                timestamp: Date.now()
            });
        })
    );

    // Show Debug Info command
    context.subscriptions.push(
        vscode.commands.registerCommand('gitAi.showDebugInfo', () => {
            const checkpointInfo = checkpointManager.getDebugInfo();
            const providerInfo = providerRegistry.getDebugInfo();

            const info = `=== Checkpoint Manager ===\n${checkpointInfo}\n\n=== Providers ===\n${providerInfo}`;

            // Show in output channel
            const outputChannel = vscode.window.createOutputChannel('Git AI Debug');
            outputChannel.clear();
            outputChannel.appendLine(info);
            outputChannel.show();
        })
    );

    // Open Full Stats command
    context.subscriptions.push(
        vscode.commands.registerCommand('gitAi.openFullStats', () => {
            checkpointManager.openFullStats();
        })
    );

    // Status Bar Menu command
    context.subscriptions.push(
        vscode.commands.registerCommand('gitAi.statusBarMenu', async () => {
            const fullStats = {
                label: "$(markdown) Open Full Stats Report...",
                description: "View full table in new editor"
            };
            const setDepth = {
                label: "$(gear) Configure Commit Depth",
                description: "Change number of commits in stats"
            };
            const debugInfo = {
                label: "$(bug) Show Debug Info",
                description: "Internal logs and provider state"
            };
            const reloadProviders = {
                label: "$(refresh) Reload Providers",
                description: "Restart AI provider detection"
            };

            const selection = await vscode.window.showQuickPick(
                [fullStats, setDepth, debugInfo, reloadProviders],
                { placeHolder: "Git AI Options" }
            );

            if (selection === fullStats) {
                checkpointManager.openFullStats();
            } else if (selection === setDepth) {
                const config = vscode.workspace.getConfiguration('gitAi');
                const currentDepth = config.get<number>('statusBarCommitDepth', 1);

                const depthInput = await vscode.window.showInputBox({
                    prompt: "Enter number of recent commits to analyze (1-100)",
                    value: currentDepth.toString(),
                    validateInput: (val) => {
                        const n = parseInt(val);
                        if (isNaN(n) || n < 1) return "Please enter a valid number greater than 0";
                        return null;
                    }
                });

                if (depthInput) {
                    await config.update('statusBarCommitDepth', parseInt(depthInput), vscode.ConfigurationTarget.Global);
                    checkpointManager.updateLastCommitStats();
                }
            } else if (selection === debugInfo) {
                vscode.commands.executeCommand('gitAi.showDebugInfo');
            } else if (selection === reloadProviders) {
                providerRegistry.stopAll();
                providerRegistry.startAll();
                vscode.window.showInformationMessage('Git AI: Providers reloaded');
            }
        })
    );

    // ==================== Cleanup ====================

    context.subscriptions.push(
        vscode.Disposable.from({
            dispose: () => {
                providerRegistry.dispose();
                checkpointManager.dispose();
            }
        })
    );

    console.log('[git-ai] Extension setup complete');
}

export function deactivate() {
    console.log('[git-ai] Extension deactivated');
}
