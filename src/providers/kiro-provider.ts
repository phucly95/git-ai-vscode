/**
 * Kiro IDE AI Provider - Detects AI activity by watching Kiro log files.
 * 
 * Detection Strategy:
 * - Watch Kiro logs directory for AI agent activity logs
 * - Parse log entries for [WriteFile] complete write file: {path}
 * - Emit AI signals with exact file paths for precise matching
 * 
 * Multi-Window Support:
 * - Each Kiro window has its own log directory (window1, window2, etc.)
 * - We identify the correct window by checking recent log file modifications
 * 
 * Session Restore:
 * - On startup, find the most recently modified log file
 * - Handle log rotation when session restarts
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BaseAIProvider } from './base-provider';
import { AIProvider, AISignalEvent } from '../types';

export class KiroProvider extends BaseAIProvider {
    private currentLogFile: string | null = null;
    private currentLogSize: number = 0;
    private pollingInterval: NodeJS.Timeout | null = null;
    private readonly POLL_INTERVAL_MS = 500; // Poll every 500ms for faster detection
    private readonly windowSessionId: string;
    private workspacePaths: string[] = [];
    private kiroDisposables: vscode.Disposable[] = [];

    // Kiro-specific signal pattern: [WriteFile] complete write file: /path/to/file
    private readonly WRITE_FILE_PATTERN = /\[WriteFile\] complete write file: (.+)/;

    constructor() {
        super('Git AI - Kiro Provider');
        // Use Process ID as the stable session identifier for this window
        this.windowSessionId = process.pid.toString();
        // Get ALL workspace paths for multi-root support
        this.workspacePaths = (vscode.workspace.workspaceFolders ?? [])
            .map(f => f.uri.fsPath);
        this.log(`Initialized with PID ${process.pid}, workspaces: ${this.workspacePaths.join(', ') || 'none'}`);
    }

    get providerType(): AIProvider {
        return 'kiro';
    }

    /**
     * Check if we're running inside Kiro IDE.
     * Kiro IDE has specific app name and URI scheme.
     */
    isInstalled(): boolean {
        const appName = vscode.env.appName?.toLowerCase() ?? '';
        const uriScheme = vscode.env.uriScheme?.toLowerCase() ?? '';

        // Check if running in Kiro IDE
        const isKiro = appName.includes('kiro') || uriScheme.includes('kiro');

        if (isKiro) {
            this.log(`Detected Kiro IDE (appName: ${vscode.env.appName}, uriScheme: ${vscode.env.uriScheme})`);
        }

        return isKiro;
    }

    startWatching(): void {
        if (this.isWatching) {
            this.log('Already watching, skipping start');
            return;
        }

        if (!this.isInstalled()) {
            this.log('Not running in Kiro IDE, skipping');
            return;
        }

        this.log(`Starting log watcher (window session: ${this.windowSessionId})`);
        this.isWatching = true;

        // Listen for workspace changes (user adds/removes folders)
        this.kiroDisposables.push(
            vscode.workspace.onDidChangeWorkspaceFolders(() => {
                this.log('Workspace folders changed, updating paths...');
                this.workspacePaths = (vscode.workspace.workspaceFolders ?? [])
                    .map(f => f.uri.fsPath);
                // Re-find log file in case we're watching wrong window
                this.stopWatching();
                this.isWatching = true;
                this.findAndWatchLogFile();
            })
        );

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

    dispose(): void {
        this.stopWatching();
        this.kiroDisposables.forEach(d => d.dispose());
        this.kiroDisposables = [];
    }

    getDebugInfo(): string {
        return JSON.stringify({
            provider: this.providerType,
            isInstalled: this.isInstalled(),
            isWatching: this.isWatching,
            logFile: this.currentLogFile,
            logFileExists: this.currentLogFile ? fs.existsSync(this.currentLogFile) : false,
            currentSize: this.currentLogSize,
            windowSessionId: this.windowSessionId
        }, null, 2);
    }

    /**
     * Find the correct log file for this Kiro window and start polling.
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
     * Find the Kiro log file for the current window.
     * Handles multiple sessions and windows.
     */
    private async findLogFile(): Promise<string | null> {
        const platform = os.platform();
        let logsDir = '';

        // Kiro uses its own Application Support directory
        if (platform === 'darwin') {
            logsDir = path.join(os.homedir(), 'Library', 'Application Support', 'Kiro', 'logs');
        } else if (platform === 'win32') {
            logsDir = path.join(os.homedir(), 'AppData', 'Roaming', 'Kiro', 'logs');
        } else {
            logsDir = path.join(os.homedir(), '.config', 'Kiro', 'logs');
        }

        if (!fs.existsSync(logsDir)) {
            this.log(`Kiro logs directory does not exist: ${logsDir}`);
            return null;
        }

        // Find session directories (format: YYYYMMDDTHHMMSS)
        const sessions = fs.readdirSync(logsDir)
            .filter(f => /^\d{8}T\d{6}$/.test(f))
            .sort()
            .reverse();

        if (sessions.length === 0) {
            this.log('No Kiro session directories found');
            return null;
        }

        this.log(`Found ${sessions.length} sessions, checking: ${sessions.slice(0, 3).join(', ')}`);

        // Try sessions from newest to oldest (check last 3 for session restore)
        for (const sessionName of sessions.slice(0, 3)) {
            const sessionDir = path.join(logsDir, sessionName);
            this.log(`Checking session: ${sessionName}`);
            const logFile = await this.findLogFileInSession(sessionDir);
            if (logFile) {
                return logFile;
            }
        }

        return null;
    }

    /**
     * Find Kiro log file within a session directory.
     * Detection priority:
     * 1. PID match (exact window identification)
     * 2. Workspace match ([WriteFile] paths match our workspace)
     * 3. Fallback to mtime (for first edit scenarios)
     */
    private async findLogFileInSession(sessionDir: string): Promise<string | null> {
        const windowDirs = fs.readdirSync(sessionDir)
            .filter(f => f.startsWith('window'))
            .map(f => path.join(sessionDir, f));

        if (windowDirs.length === 0) {
            return null;
        }

        // STRATEGY 1: Try exact PID match first (handles same-workspace multi-window)
        const myWindowDir = this.findWindowDirByPid(windowDirs);
        if (myWindowDir) {
            const logFile = this.findKiroLogInWindow(myWindowDir);
            if (logFile) {
                this.log(`Selected log (PID match): ${logFile}`);
                return logFile;
            }
        }

        // Collect all candidate log files
        const candidates: Array<{ path: string; mtime: number; windowDir: string }> = [];
        const now = Date.now();
        const MAX_AGE_MS = 1800000; // 30 minutes

        for (const windowDir of windowDirs) {
            const logFile = this.findKiroLogInWindow(windowDir);
            if (logFile) {
                try {
                    const stats = fs.statSync(logFile);
                    if (now - stats.mtimeMs < MAX_AGE_MS) {
                        candidates.push({ path: logFile, mtime: stats.mtimeMs, windowDir });
                    }
                } catch (e) {
                    this.log(`Error checking ${logFile}: ${e}`);
                }
            }
        }

        if (candidates.length === 0) {
            return null;
        }

        // STRATEGY 2: Find log with WriteFile paths matching our workspace
        if (this.workspacePaths.length > 0) {
            for (const candidate of candidates) {
                if (this.logMatchesWorkspace(candidate.path)) {
                    this.log(`Selected log (workspace match): ${candidate.path}`);
                    return candidate.path;
                }
            }
        }

        // STRATEGY 3: Fallback to mtime (for first edit or no match scenarios)
        candidates.sort((a, b) => {
            // Prefer Kiro Logs.log over KiroLLMLogs.log
            const aIsMain = a.path.endsWith('Kiro Logs.log');
            const bIsMain = b.path.endsWith('Kiro Logs.log');
            if (aIsMain && !bIsMain) return -1;
            if (!aIsMain && bIsMain) return 1;
            return b.mtime - a.mtime;
        });

        this.log(`Selected log (mtime fallback): ${candidates[0].path}`);
        return candidates[0].path;
    }

    /**
     * Find Kiro log file in a window directory.
     */
    private findKiroLogInWindow(windowDir: string): string | null {
        const extHostDir = path.join(windowDir, 'exthost');
        if (!fs.existsSync(extHostDir)) return null;

        try {
            const kiroDirs = fs.readdirSync(extHostDir).filter(f => f.includes('kiro'));
            for (const kiroDir of kiroDirs) {
                const logFile = path.join(extHostDir, kiroDir, 'Kiro Logs.log');
                if (fs.existsSync(logFile)) {
                    return logFile;
                }
            }
        } catch (e) {
            this.log(`Error finding log in ${windowDir}: ${e}`);
        }
        return null;
    }

    /**
     * Find the window directory matching our extension host PID.
     * Each window has its own exthost.log with "Extension host with pid XXXX started"
     */
    private findWindowDirByPid(windowDirs: string[]): string | null {
        const myPid = process.pid.toString();

        for (const windowDir of windowDirs) {
            const exthostLog = path.join(windowDir, 'exthost', 'exthost.log');
            if (fs.existsSync(exthostLog)) {
                try {
                    // Read first 500 bytes - PID is in the first line
                    const fd = fs.openSync(exthostLog, 'r');
                    const buffer = Buffer.alloc(500);
                    fs.readSync(fd, buffer, 0, 500, 0);
                    fs.closeSync(fd);

                    const content = buffer.toString();
                    if (content.includes(`pid ${myPid}`)) {
                        this.log(`Found my window by PID ${myPid}: ${path.basename(windowDir)}`);
                        return windowDir;
                    }
                } catch (e) {
                    // Ignore read errors
                }
            }
        }
        return null;
    }

    /**
     * Check if a log file contains WriteFile entries matching our workspace paths.
     */
    private logMatchesWorkspace(logPath: string): boolean {
        try {
            const stats = fs.statSync(logPath);
            if (stats.size === 0) return false;

            // Read last 50KB of log file
            const readSize = Math.min(50000, stats.size);
            const start = Math.max(0, stats.size - readSize);
            const fd = fs.openSync(logPath, 'r');
            const buffer = Buffer.alloc(readSize);
            fs.readSync(fd, buffer, 0, readSize, start);
            fs.closeSync(fd);

            const content = buffer.toString();
            const writeFileMatches = content.match(/\[WriteFile\] complete write file: (.+)/g);
            if (!writeFileMatches) return false;

            // Check if ANY WriteFile path matches ANY of our workspaces
            for (const match of writeFileMatches) {
                const filePath = match.replace('[WriteFile] complete write file: ', '').trim();
                for (const wsPath of this.workspacePaths) {
                    if (filePath.startsWith(wsPath)) {
                        this.log(`Found matching WriteFile in ${path.basename(wsPath)}`);
                        return true;
                    }
                }
            }
            return false;
        } catch (e) {
            return false;
        }
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
                // Log file might have been rotated (new session), try to find new one
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
        const lines = content.split('\n');

        for (const line of lines) {
            if (!line.trim()) continue;

            // Check for WriteFile signal with file path
            const writeMatch = line.match(this.WRITE_FILE_PATTERN);
            if (writeMatch) {
                const filePath = writeMatch[1].trim();

                this.log(`Signal detected: [WriteFile] ${path.basename(filePath)}`);

                // Emit signal with exact file path - CheckpointManager handles deduplication
                this.emitSignal({
                    filePaths: [filePath],
                    sessionId: this.windowSessionId
                });
            }
        }
    }





    /**
     * SYNCHRONOUS check for AI signal that matches a specific file change.
     * 
     * Unlike AWS Q which uses timestamp tolerance, Kiro provides exact file paths
     * in the log, so we can match precisely by file path.
     * 
     * @param fileChangeTimestamp - When the file change was detected (ms since epoch)
     * @param filePath - Optional: specific file path to match
     * @param toleranceMs - Max time difference (default 500ms based on log analysis)
     * @returns AISignalEvent if found, null otherwise
     */
    public hasAISignalForChange(fileChangeTimestamp: number, toleranceMs: number = 500, filePath?: string): AISignalEvent | null {
        if (!this.currentLogFile || !fs.existsSync(this.currentLogFile)) {
            this.log('No log file available for synchronous check');
            return null;
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

            // Parse lines in reverse (newest first)
            for (let i = lines.length - 1; i >= 0; i--) {
                const line = lines[i];
                if (!line.trim()) continue;

                // Check for WriteFile signal
                const writeMatch = line.match(this.WRITE_FILE_PATTERN);
                if (!writeMatch) continue;

                const logFilePath = writeMatch[1].trim();

                // If specific file path provided, match exactly
                if (filePath && logFilePath !== filePath) {
                    continue;
                }

                // Extract timestamp from log line (format: 2026-01-21 11:06:19.809)
                const timestampMatch = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})/);
                if (!timestampMatch) continue;

                const logTime = new Date(timestampMatch[1].replace(' ', 'T'));
                const logTimestamp = logTime.getTime();
                const timeDiff = Math.abs(fileChangeTimestamp - logTimestamp);

                // Check if log entry correlates with file change (within tolerance)
                if (timeDiff <= toleranceMs) {
                    this.log(`Synchronous check: Found Kiro AI signal for ${path.basename(logFilePath)}, ` +
                        `diff=${timeDiff}ms from file change`);

                    return {
                        provider: 'kiro',
                        timestamp: logTimestamp,
                        filePaths: [logFilePath],
                        sessionId: this.windowSessionId
                    };
                }

                // If log entry is too old (more than 30 seconds before file change), stop searching
                if (logTimestamp < fileChangeTimestamp - 30000) {
                    break;
                }
            }

            this.log(`Synchronous check: No correlating Kiro AI signal found within ${toleranceMs}ms`);
            return null;

        } catch (err) {
            this.log(`Synchronous check error: ${err}`);
            return null;
        }
    }

    /**
     * Get the current log file path (for debugging).
     */
    public getLogFilePath(): string | null {
        return this.currentLogFile;
    }
}
