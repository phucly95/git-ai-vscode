/**
 * AWS Q AI Provider - Detects AI activity by watching Amazon Q log files.
 * 
 * Detection Strategy:
 * - Watch VS Code logs directory for Amazon Q extension logs
 * - Parse log entries for file system operations (fsReplace, fsWrite, fsDelete)
 * - Emit AI signals when these operations are detected
 * 
 * Multi-Window Support:
 * - Each VS Code window has its own log directory (window1, window2, etc.)
 * - We identify the correct window by checking recent log file modifications
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BaseAIProvider } from './base-provider';
import { AIProvider, PROVIDER_CONFIGS } from '../types';

export class AwsQProvider extends BaseAIProvider {
    private currentLogFile: string | null = null;
    private currentLogSize: number = 0;
    private pollingInterval: NodeJS.Timeout | null = null;
    private readonly POLL_INTERVAL_MS = 500; // Poll every 500ms for faster detection
    private readonly windowSessionId: string;

    constructor() {
        super('Git AI - AWS Q Provider');
        this.windowSessionId = vscode.env.sessionId;
    }

    get providerType(): AIProvider {
        return 'aws-q';
    }

    startWatching(): void {
        if (this.isWatching) {
            this.log('Already watching, skipping start');
            return;
        }

        if (!this.isInstalled()) {
            this.log('Amazon Q extension not installed');
            return;
        }

        this.log(`Starting log watcher (window session: ${this.windowSessionId})`);
        this.isWatching = true;
        this.findAndWatchLogFile();
    }

    stopWatching(): void {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
        this.isWatching = false;
        this.currentLogFile = null;
        this.currentLogSize = 0;
        this.log('Stopped watching');
    }

    getDebugInfo(): string {
        return JSON.stringify({
            provider: this.providerType,
            isWatching: this.isWatching,
            logFile: this.currentLogFile,
            logFileExists: this.currentLogFile ? fs.existsSync(this.currentLogFile) : false,
            currentSize: this.currentLogSize,
            windowSessionId: this.windowSessionId
        }, null, 2);
    }

    /**
     * Find the correct log file for this VS Code window and start polling.
     */
    private async findAndWatchLogFile(): Promise<void> {
        const logFile = await this.findLogFile();

        if (logFile) {
            this.log(`Found log file: ${logFile}`);
            this.tailFile(logFile);
        } else {
            this.log('Log file not found, retrying in 10s...');
            setTimeout(() => {
                if (this.isWatching) {
                    this.findAndWatchLogFile();
                }
            }, 10000);
        }
    }

    /**
     * Find the Amazon Q log file for the current VS Code window.
     */
    private async findLogFile(): Promise<string | null> {
        const platform = os.platform();
        let logsDir = '';

        if (platform === 'darwin') {
            logsDir = path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'logs');
        } else if (platform === 'win32') {
            logsDir = path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'logs');
        } else {
            logsDir = path.join(os.homedir(), '.config', 'Code', 'logs');
        }

        if (!fs.existsSync(logsDir)) {
            this.log(`Logs directory does not exist: ${logsDir}`);
            return null;
        }

        // Find latest session directory (format: YYYYMMDDTHHMMSS)
        const sessions = fs.readdirSync(logsDir)
            .filter(f => /^\d{8}T\d{6}$/.test(f))
            .sort()
            .reverse();

        if (sessions.length === 0) {
            this.log('No session directories found');
            return null;
        }

        // Try sessions from newest to oldest
        for (const sessionName of sessions.slice(0, 3)) { // Check last 3 sessions
            const sessionDir = path.join(logsDir, sessionName);
            const logFile = await this.findLogFileInSession(sessionDir);
            if (logFile) {
                return logFile;
            }
        }

        return null;
    }

    /**
     * Find Amazon Q log file within a session directory.
     * Handles multi-window scenarios by finding the most recently modified log.
     */
    private async findLogFileInSession(sessionDir: string): Promise<string | null> {
        const windowDirs = fs.readdirSync(sessionDir)
            .filter(f => f.startsWith('window'))
            .map(f => path.join(sessionDir, f));

        if (windowDirs.length === 0) {
            return null;
        }

        const candidates: Array<{ path: string; mtime: number }> = [];
        const now = Date.now();
        const MAX_AGE_MS = 300000; // 5 minutes

        for (const windowDir of windowDirs) {
            const extHostDir = path.join(windowDir, 'exthost');
            if (!fs.existsSync(extHostDir)) continue;

            try {
                const awsqDirs = fs.readdirSync(extHostDir)
                    .filter(f => f.includes('amazon-q-vscode'));

                for (const awsqDir of awsqDirs) {
                    const logPatterns = PROVIDER_CONFIGS['aws-q'].logPatterns || [];
                    for (const pattern of logPatterns) {
                        const logFile = path.join(extHostDir, awsqDir, pattern);
                        if (fs.existsSync(logFile)) {
                            const stats = fs.statSync(logFile);
                            // Only consider logs modified within the last 5 minutes
                            if (now - stats.mtimeMs < MAX_AGE_MS) {
                                candidates.push({ path: logFile, mtime: stats.mtimeMs });
                            }
                        }
                    }
                }
            } catch (e) {
                this.log(`Error scanning ${windowDir}: ${e}`);
            }
        }

        if (candidates.length === 0) {
            return null;
        }

        // Return the most recently modified log file
        candidates.sort((a, b) => b.mtime - a.mtime);
        return candidates[0].path;
    }

    /**
     * Start polling the log file for new content.
     */
    private tailFile(filePath: string): void {
        this.currentLogFile = filePath;

        try {
            const stats = fs.statSync(filePath);
            this.currentLogSize = stats.size;
        } catch (e) {
            this.log(`Error getting initial file size: ${e}`);
            this.currentLogSize = 0;
        }

        this.log(`Starting polling at position ${this.currentLogSize}`);

        // Stop any existing interval
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
        }

        this.pollingInterval = setInterval(() => {
            this.pollLogFile(filePath);
        }, this.POLL_INTERVAL_MS);
    }

    /**
     * Poll the log file for new content.
     */
    private pollLogFile(filePath: string): void {
        try {
            if (!fs.existsSync(filePath)) {
                // Log file might have been rotated, try to find new one
                this.log('Log file no longer exists, searching for new one...');
                this.stopWatching();
                this.isWatching = true;
                this.findAndWatchLogFile();
                return;
            }

            const stats = fs.statSync(filePath);
            const newSize = stats.size;

            // Handle log file truncation/rotation
            if (newSize < this.currentLogSize) {
                this.log(`Log file truncated (${this.currentLogSize} -> ${newSize}), resetting`);
                this.currentLogSize = 0;
            }

            if (newSize === this.currentLogSize) {
                return; // No new content
            }

            // Read new content
            const stream = fs.createReadStream(filePath, {
                start: this.currentLogSize,
                end: newSize - 1
            });

            let buffer = '';
            stream.on('data', (chunk) => {
                buffer += chunk.toString();
            });

            stream.on('end', () => {
                this.currentLogSize = newSize;
                this.processLogContent(buffer);
            });

            stream.on('error', (err) => {
                this.log(`Stream error: ${err}`);
            });

        } catch (err) {
            this.log(`Polling error: ${err}`);
        }
    }

    /**
     * Process new log content and detect AI signals.
     */
    private processLogContent(content: string): void {
        const signalKeywords = PROVIDER_CONFIGS['aws-q'].signalKeywords || [];
        const lines = content.split('\n');

        for (const line of lines) {
            if (!line.trim()) continue;

            // Check if line contains any signal keywords
            const matched = signalKeywords.some(keyword => line.includes(keyword));

            if (matched) {
                this.log(`Signal detected: ${line.substring(0, 100)}...`);

                // Try to extract file paths from the log line
                const filePaths = this.extractFilePaths(line);

                // Try to extract session ID if present
                const sessionId = this.extractSessionId(line);

                this.emitSignal({
                    filePaths,
                    sessionId
                });
            }
        }
    }

    /**
     * Extract file paths from a log line (best effort).
     */
    private extractFilePaths(line: string): string[] {
        const paths: string[] = [];

        // Pattern: Look for quoted paths or common path patterns
        const pathPatterns = [
            /"([^"]+\.[a-zA-Z]+)"/g,  // Quoted paths with extension
            /path['":\s]+([^\s'"]+)/gi,  // path: /some/path
            /file['":\s]+([^\s'"]+)/gi   // file: /some/path
        ];

        for (const pattern of pathPatterns) {
            let match;
            while ((match = pattern.exec(line)) !== null) {
                if (match[1] && match[1].includes('/')) {
                    paths.push(match[1]);
                }
            }
        }

        return [...new Set(paths)]; // Deduplicate
    }

    /**
     * Extract session ID from a log line (best effort).
     */
    private extractSessionId(line: string): string | undefined {
        // Pattern: Look for session/conversation IDs
        const sessionPatterns = [
            /session[Ii]d['":\s]+([a-zA-Z0-9-]+)/,
            /conversation[Ii]d['":\s]+([a-zA-Z0-9-]+)/,
            /chatSessionId['":\s]+([a-zA-Z0-9-]+)/
        ];

        for (const pattern of sessionPatterns) {
            const match = line.match(pattern);
            if (match && match[1]) {
                return match[1];
            }
        }

        return undefined;
    }

    /**
     * SYNCHRONOUS check for AI signal that correlates with a specific file change.
     * 
     * Instead of checking "was there any AI signal recently", this checks:
     * "was there an AI signal at approximately the same time as this file change?"
     * 
     * Based on log analysis, AWS Q edit latency is typically 2-6ms, so 500ms tolerance 
     * provides ample margin while avoiding false positives from edits seconds apart.
     * 
     * @param fileChangeTimestamp - When the file change was detected (ms since epoch)
     * @param toleranceMs - Max time difference between log entry and file change (default 500ms)
     * @returns true if AI signal found that correlates with the file change
     */
    public hasAISignalForChange(fileChangeTimestamp: number, toleranceMs: number = 500): boolean {
        if (!this.currentLogFile || !fs.existsSync(this.currentLogFile)) {
            this.log('No log file available for synchronous check');
            return false;
        }

        try {
            const stats = fs.statSync(this.currentLogFile);
            const fileSize = stats.size;

            // Read last 50KB of log file (should contain recent entries)
            const readSize = Math.min(50000, fileSize);
            const startPosition = Math.max(0, fileSize - readSize);

            const fd = fs.openSync(this.currentLogFile, 'r');
            const buffer = Buffer.alloc(readSize);
            fs.readSync(fd, buffer, 0, readSize, startPosition);
            fs.closeSync(fd);

            const content = buffer.toString('utf8');
            const lines = content.split('\n');

            const signalKeywords = PROVIDER_CONFIGS['aws-q'].signalKeywords || [];

            // Parse lines in reverse (newest first)
            for (let i = lines.length - 1; i >= 0; i--) {
                const line = lines[i];
                if (!line.trim()) continue;

                // Check if line contains signal keywords
                const hasSignal = signalKeywords.some(keyword => line.includes(keyword));
                if (!hasSignal) continue;

                // Extract timestamp from log line (format: 2026-01-20 17:11:25.981)
                const timestampMatch = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})/);
                if (!timestampMatch) continue;

                const logTime = new Date(timestampMatch[1].replace(' ', 'T'));
                const logTimestamp = logTime.getTime();
                const timeDiff = Math.abs(fileChangeTimestamp - logTimestamp);

                // Check if log entry correlates with file change (within tolerance)
                if (timeDiff <= toleranceMs) {
                    this.log(`Synchronous check: Found AI signal at ${timestampMatch[1]}, ` +
                        `diff=${timeDiff}ms from file change at ${new Date(fileChangeTimestamp).toISOString()}`);
                    return true;
                }

                // If log entry is too old (more than 30 seconds before file change), stop searching
                if (logTimestamp < fileChangeTimestamp - 30000) {
                    break;
                }
            }

            this.log(`Synchronous check: No correlating AI signal found within ${toleranceMs}ms of file change`);
            return false;

        } catch (err) {
            this.log(`Synchronous check error: ${err}`);
            return false;
        }
    }

    /**
     * Get the current log file path (for external access).
     */
    public getLogFilePath(): string | null {
        return this.currentLogFile;
    }
}
