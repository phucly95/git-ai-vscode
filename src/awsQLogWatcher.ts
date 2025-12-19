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
    private intervalId: NodeJS.Timeout | null = null;

    constructor(checkpointManager: CheckpointManager) {
        this.checkpointManager = checkpointManager;
        this.outputChannel = vscode.window.createOutputChannel("Git AI Log Watcher");
        this.startWatching();
    }

    private startWatching() {
        this.findLogFile().then(logFile => {
            if (logFile) {
                this.outputChannel.appendLine(`[WATCHER] Found Amazon Q log file: ${logFile}`);
                this.checkpointManager.updateStatus("Git AI: Watching", "eye", `Watching Log: ${path.basename(logFile)}`);
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

        this.outputChannel.appendLine(`[WATCHER] Monitoring started (Polling). Current size: ${this.currentLogSize}`);

        // fs.watch can be unreliable on some OS/Text editors. Using polling instead.
        this.intervalId = setInterval(() => {
            this.checkLogUpdates(filePath);
        }, 1000); // Check every 1 second
    }

    private checkLogUpdates(filePath: string) {
        try {
            // Check if file still exists
            if (!fs.existsSync(filePath)) return;

            const stats = fs.statSync(filePath);
            const newSize = stats.size;

            if (newSize < this.currentLogSize) {
                this.outputChannel.appendLine(`[WATCHER] Log reduced? Resetting size. ${this.currentLogSize} -> ${newSize}`);
                this.currentLogSize = newSize;
                return;
            }

            this.outputChannel.appendLine(`[WATCHER] New data detected! ${this.currentLogSize} -> ${newSize} (+${newSize - this.currentLogSize} bytes)`);

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

            stream.on('error', (err) => {
                this.outputChannel.appendLine(`[ERROR] Stream error: ${err}`);
            });

        } catch (err) {
            this.outputChannel.appendLine(`[ERROR] Error polling log: ${err}`);
        }
    }

    private processLogContent(content: string) {
        const lines = content.split('\n');
        for (const line of lines) {
            if (!line.trim()) continue;

            // Heuristic string matching
            // We'll log the first 200 chars to debug what we see
            // this.outputChannel.appendLine(`[DEBUG] Line: ${line.substring(0, 150)}`);

            if (line.includes('fsReplace') || line.includes('fsWrite') || line.includes('fsDelete') || line.includes('agenticCodeAccepted')) {
                this.outputChannel.appendLine(`[WATCHER] !!! MATCHED SIGNAL !!! : ${line.substring(0, 100)}...`);
                this.checkpointManager.updateStatus("Git AI: Signal Detected", "broadcast");
                this.checkpointManager.signalAiActivity();
            }
        }
    }

    public getDebugInfo(): string {
        return `Watched File: ${this.currentLogFile}\nFile Valid: ${fs.existsSync(this.currentLogFile || '')}\nSize: ${this.currentLogSize}`;
    }

    public dispose() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
        }
    }
}
