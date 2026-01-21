/**
 * Kiro IDE AI Provider - Placeholder for future Kiro IDE support.
 * 
 * TODO: Implement Kiro-specific detection logic when Kiro IDE is available.
 * This placeholder ensures the architecture is ready for extension.
 */

import * as vscode from 'vscode';
import { BaseAIProvider } from './base-provider';
import { AIProvider } from '../types';

export class KiroProvider extends BaseAIProvider {
    constructor() {
        super('Git AI - Kiro Provider');
    }

    get providerType(): AIProvider {
        return 'kiro';
    }

    /**
     * Check if Kiro IDE is installed.
     * TODO: Update with actual Kiro extension ID.
     */
    isInstalled(): boolean {
        // TODO: Replace with actual Kiro extension detection
        // For now, check if we're running in Kiro IDE by examining the environment
        const appName = vscode.env.appName?.toLowerCase() ?? '';
        const uriScheme = vscode.env.uriScheme?.toLowerCase() ?? '';

        return appName.includes('kiro') || uriScheme.includes('kiro');
    }

    startWatching(): void {
        if (!this.isInstalled()) {
            this.log('Kiro IDE not detected, skipping');
            return;
        }

        this.log('Starting Kiro activity detection');
        this.isWatching = true;

        // TODO: Implement Kiro-specific log watching or event detection
        // This will depend on how Kiro IDE exposes AI activity
        this.log('WARNING: Kiro detection not yet implemented');
    }

    stopWatching(): void {
        this.isWatching = false;
        this.log('Stopped watching');
    }

    getDebugInfo(): string {
        return JSON.stringify({
            provider: this.providerType,
            isInstalled: this.isInstalled(),
            isWatching: this.isWatching,
            status: 'Not yet implemented'
        }, null, 2);
    }
}
