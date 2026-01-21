/**
 * Abstract base class for AI providers.
 * Implement this class to add support for new AI providers (e.g., Kiro IDE).
 */

import * as vscode from 'vscode';
import { AIProvider, AISignalEvent, AISignalHandler, ProviderConfig, PROVIDER_CONFIGS } from '../types';

export abstract class BaseAIProvider implements vscode.Disposable {
    protected outputChannel: vscode.OutputChannel;
    protected signalHandler?: AISignalHandler;
    protected isWatching = false;
    protected disposables: vscode.Disposable[] = [];

    constructor(channelName: string) {
        this.outputChannel = vscode.window.createOutputChannel(channelName);
    }

    /**
     * Get the provider type identifier.
     */
    abstract get providerType(): AIProvider;

    /**
     * Get the configuration for this provider.
     */
    get config(): ProviderConfig {
        return PROVIDER_CONFIGS[this.providerType];
    }

    /**
     * Check if the AI provider extension is installed.
     */
    isInstalled(): boolean {
        const extensionId = this.config.extensionId;
        if (!extensionId) {
            return false;
        }
        return vscode.extensions.getExtension(extensionId) !== undefined;
    }

    /**
     * Check if the AI provider extension is active.
     */
    isActive(): boolean {
        const extensionId = this.config.extensionId;
        if (!extensionId) {
            return false;
        }
        const ext = vscode.extensions.getExtension(extensionId);
        return ext?.isActive ?? false;
    }

    /**
     * Set the callback handler for AI signals.
     */
    setSignalHandler(handler: AISignalHandler): void {
        this.signalHandler = handler;
    }

    /**
     * Start watching for AI activity.
     * Implement provider-specific detection logic in subclasses.
     */
    abstract startWatching(): void;

    /**
     * Stop watching for AI activity.
     * Clean up any resources (timers, watchers, etc.)
     */
    abstract stopWatching(): void;

    /**
     * Get debug information about the provider state.
     */
    abstract getDebugInfo(): string;

    /**
     * Emit an AI signal event to the checkpoint manager.
     */
    protected emitSignal(event: Partial<AISignalEvent>): void {
        if (!this.signalHandler) {
            this.outputChannel.appendLine(`[WARN] No signal handler registered for ${this.providerType}`);
            return;
        }

        const fullEvent: AISignalEvent = {
            provider: this.providerType,
            timestamp: Date.now(),
            ...event
        };

        this.outputChannel.appendLine(`[SIGNAL] Emitting: ${JSON.stringify(fullEvent)}`);
        this.signalHandler(fullEvent);
    }

    /**
     * Log a message to the output channel.
     */
    protected log(message: string): void {
        this.outputChannel.appendLine(`[${this.config.displayName}] ${message}`);
    }

    /**
     * Clean up resources when the provider is disposed.
     */
    dispose(): void {
        this.stopWatching();
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
        this.outputChannel.dispose();
    }
}
