import { execSync } from 'child_process';
import path from 'path';

export function getChangedFiles({ projectRoot = process.cwd(), range = 'HEAD~1..HEAD' }) {
    try {
        const output = execSync(`git diff --name-only ${range}`, {
            cwd: projectRoot,
            stdio: ['ignore', 'pipe', 'ignore'],
            encoding: 'utf8',
        });
        return output
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .map((p) => path.resolve(projectRoot, p));
    } catch (err) {
        return [];
    }
}

