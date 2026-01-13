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

export function getChangedRanges({ projectRoot = process.cwd(), range = 'HEAD~1..HEAD', files = [] }) {
    const map = {};
    const normKey = (p) => {
        if (!p) return p;
        let k = p.replace(/^a\//, '').replace(/^b\//, '').replace(/^\.?\//, '');
        if (k.startsWith('../')) k = k.replace(/^\.\.\//, '');
        return k;
    };
    try {
        const rels = files
            .map((p) => path.relative(projectRoot, p))
            .filter((p) => p && p !== '.' && !p.startsWith('..'));
        const args = ['diff', '--no-color', '--unified=0', range];
        if (rels.length) {
            args.push('--', ...rels);
        }
        const output = execSync(`git ${args.join(' ')}`, {
            cwd: projectRoot,
            stdio: ['ignore', 'pipe', 'ignore'],
            encoding: 'utf8',
        });
        const lines = output.split('\n');
        let current = null;
        const hunkRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
        for (const line of lines) {
            if (line.startsWith('diff --git')) {
                current = null;
                continue;
            }
            if (line.startsWith('+++ ')) {
                const filePath = line.replace('+++ ', '').trim();
                current = normKey(filePath.replace(/^b\//, ''));
                if (!map[current]) map[current] = [];
                continue;
            }
            const m = hunkRe.exec(line);
            if (m && current) {
                const start = Number(m[1]);
                const count = m[2] ? Number(m[2]) : 1;
                const key = normKey(current);
                if (!map[key]) map[key] = [];
                map[key].push({ start, end: start + count - 1 });
            }
        }
    } catch (err) {
        // ignore, return empty map
    }
    return map;
}

