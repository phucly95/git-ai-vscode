import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CheckpointManager } from './checkpointManager';

export class AwsQLogWatcher {
    private checkpointManager: CheckpointManager;
    private outputChannel: vscode.OutputChannel;
    private currentLogFile: string | null = null;
    private currentLogSize: number = 0;
    private watcher: fs.FSWatcher | null = null;

    constructor(checkpointManager: CheckpointManager) {
        this.checkpointManager = checkpointManager;
        this.outputChannel = vscode.window.createOutputChannel("Git AI Log Watcher");
        this.startWatching();
    }

    private startWatching() {
        this.findLogFile().then(logFile => {
            if (logFile) {
                this.outputChannel.appendLine(`[WATCHER] Found Amazon Q log file: ${logFile}`);
                this.tailFile(logFile);
            } else {
                this.outputChannel.appendLine("[WATCHER] Amazon Q log file not found. Retrying in 10s...");
                setTimeout(() => this.startWatching(), 10000);
            }
        });
    }

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
            this.outputChannel.appendLine(`[WATCHER] Logs directory does not exist: ${logsDir}`);
            return null;
        }

        // 1. Find latest session directory (timestamp)
        const sessions = fs.readdirSync(logsDir)
            .filter(f => /^\d{8}T\d{6}$/.test(f)) // Format: YYYYMMDDTHHMMSS
            .sort().reverse();

        if (sessions.length === 0) return null;

        const latestSession = sessions[0];
        const sessionDir = path.join(logsDir, latestSession);

        // 2. Search for window*/exthost/amazonwebservices.amazon-q-vscode/Amazon Q Logs.log
        // "window1", "window2", etc.
        const windowDirs = fs.readdirSync(sessionDir).filter(f => f.startsWith('window'));

        for (const windowDir of windowDirs) {
            const extHostDir = path.join(sessionDir, windowDir, 'exthost');
            if (!fs.existsSync(extHostDir)) continue;

            const candidates = fs.readdirSync(extHostDir).filter(f => f.includes('amazon-q-vscode'));
            for (const candidate of candidates) {
                const logFile = path.join(extHostDir, candidate, 'Amazon Q Logs.log');
                if (fs.existsSync(logFile)) {
                    return logFile;
                }
            }
        }

        return null;
    }

    private tailFile(filePath: string) {
        this.currentLogFile = filePath;
        const stats = fs.statSync(filePath);
        this.currentLogSize = stats.size;

        this.outputChannel.appendLine(`[WATCHER] Monitoring started. Current size: ${this.currentLogSize}`);

        this.watcher = fs.watch(filePath, (eventType) => {
            if (eventType === 'change') {
                this.readNewContent(filePath);
            }
        });
    }

    private readNewContent(filePath: string) {
        try {
            const stats = fs.statSync(filePath);
            const newSize = stats.size;

            if (newSize < this.currentLogSize) {
                // Log rotated or truncated? Reset.
                this.currentLogSize = newSize;
                return;
            }

            if (newSize === this.currentLogSize) return;

            const stream = fs.createReadStream(filePath, {
                start: this.currentLogSize,
                end: newSize
            });

            let buffer = '';
            stream.on('data', (chunk) => {
                buffer += chunk.toString();
            });

            stream.on('end', () => {
                this.currentLogSize = newSize;
                this.processLogContent(buffer);
            });

        } catch (err) {
            this.outputChannel.appendLine(`[ERROR] Error reading log: ${err}`);
        }
    }

    private processLogContent(content: string) {
        const lines = content.split('\n');
        for (const line of lines) {
            if (!line.trim()) continue;

            // Heuristic string matching for performance before regex/json parse
            if (line.includes('fsReplace') || line.includes('fsWrite') || line.includes('fsDelete') || line.includes('agenticCodeAccepted')) {
                this.outputChannel.appendLine(`[WATCHER] Detected Signal in line: ${line.substring(0, 100)}...`);
                this.checkpointManager.signalAiActivity();
            }
        }
    }

    public dispose() {
        if (this.watcher) {
            this.watcher.close();
        }
    }
}
