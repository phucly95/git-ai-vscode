/**
 * Provider Registry - Manages all AI providers and routes signals to checkpoint manager.
 */

import * as vscode from 'vscode';
import { BaseAIProvider } from './base-provider';
import { AwsQProvider } from './awsq-provider';
import { KiroProvider } from './kiro-provider';
import { AISignalEvent, AISignalHandler } from '../types';

export class ProviderRegistry implements vscode.Disposable {
    private providers: BaseAIProvider[] = [];
    private signalHandler?: AISignalHandler;
    private outputChannel: vscode.OutputChannel;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('Git AI - Provider Registry');
        this.initializeProviders();
    }

    /**
     * Initialize all known providers.
     */
    private initializeProviders(): void {
        // Add all provider implementations
        // ORDER MATTERS: Specific/Local providers (Kiro) should be checked before Generic/Cloud providers (AwsQ)
        this.providers = [
            new KiroProvider(),
            new AwsQProvider()
        ];

        this.outputChannel.appendLine(`[REGISTRY] Initialized ${this.providers.length} providers`);
    }

    /**
     * Set the signal handler that will receive events from all providers.
     */
    setSignalHandler(handler: AISignalHandler): void {
        this.signalHandler = handler;

        // Forward handler to all providers
        for (const provider of this.providers) {
            provider.setSignalHandler(this.handleSignal.bind(this));
        }
    }

    /**
     * Handle signals from providers and forward to checkpoint manager.
     */
    private handleSignal(event: AISignalEvent): void {
        this.outputChannel.appendLine(`[REGISTRY] Received signal from ${event.provider}`);

        if (this.signalHandler) {
            this.signalHandler(event);
        }
    }

    /**
     * Start watching on all installed providers.
     */
    startAll(): void {
        for (const provider of this.providers) {
            if (provider.isInstalled()) {
                this.outputChannel.appendLine(`[REGISTRY] Starting ${provider.providerType} (installed: true)`);
                provider.startWatching();
            } else {
                this.outputChannel.appendLine(`[REGISTRY] Skipping ${provider.providerType} (not installed)`);
            }
        }
    }

    /**
     * Stop watching on all providers.
     */
    stopAll(): void {
        for (const provider of this.providers) {
            provider.stopWatching();
        }
    }

    /**
     * Get debug info from all providers.
     */
    getDebugInfo(): string {
        const info: Record<string, string> = {};
        for (const provider of this.providers) {
            info[provider.providerType] = provider.getDebugInfo();
        }
        return JSON.stringify(info, null, 2);
    }

    /**
     * Get list of installed providers.
     */
    getInstalledProviders(): BaseAIProvider[] {
        return this.providers.filter(p => p.isInstalled());
    }

    /**
     * Check if any AI provider is installed.
     */
    hasAnyProvider(): boolean {
        return this.providers.some(p => p.isInstalled());
    }

    /**
     * SYNCHRONOUS check if any provider has AI signal correlating with a file change.
     * This reads the log file directly, not relying on polling.
     * 
     * @param fileChangeTimestamp - When the file was changed (ms since epoch)
     * @param toleranceMs - Max time difference (default 500ms based on log analysis)
     * @returns AISignalEvent if found, null otherwise
     */
    hasAISignalForChange(fileChangeTimestamp: number, toleranceMs: number = 500): AISignalEvent | null {
        for (const provider of this.providers) {
            if (!provider.isInstalled()) continue;

            // Check if provider supports synchronous check
            if ('hasAISignalForChange' in provider && typeof (provider as any).hasAISignalForChange === 'function') {
                const signal = (provider as any).hasAISignalForChange(fileChangeTimestamp, toleranceMs);
                if (signal) {
                    this.outputChannel.appendLine(
                        `[REGISTRY] Synchronous check: ${provider.providerType} reports AI signal for change`
                    );
                    return signal; // Return the full event object
                }
            }
        }
        return null;
    }

    /**
     * Clean up all providers.
     */
    dispose(): void {
        this.stopAll();
        for (const provider of this.providers) {
            provider.dispose();
        }
        this.providers = [];
        this.outputChannel.dispose();
    }
}
