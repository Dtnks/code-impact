import { execSync, spawnSync } from 'child_process';
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
    const debug = {
        rels: [],
        firstArgs: null,
        firstOutLen: 0,
        firstOutSample: '',
        allArgs: null,
        allOutLen: 0,
        allOutSample: '',
        fallbackArgs: null,
        fallbackOutLen: 0,
        fallbackOutSample: '',
    };
    const normKey = (p) => {
        if (!p) return p;
        let k = p.replace(/^a\//, '').replace(/^b\//, '').replace(/^\.?\//, '');
        if (path.isAbsolute(k)) {
            const rel = path.relative(projectRoot, k);
            if (rel && !rel.startsWith('..')) k = rel;
        }
        if (k.startsWith('../')) k = k.replace(/^\.\.\//, '');
        k = k.split(path.sep).join('/'); // normalize to posix
        return k;
    };
    const parseDiff = (output) => {
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
    };

    const runDiff = (args) => {
        const res = spawnSync('git', args, {
            cwd: projectRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (res.error) return '';
        if (res.status === 0 || res.status === 1) {
            if (!res.stdout && res.stderr) return res.stderr;
            return res.stdout || '';
        }
        if (res.stdout) return res.stdout;
        if (res.stderr) return res.stderr;
        return '';
    };

    try {
        const rels = files
            .map((p) => path.relative(projectRoot, p))
            .filter((p) => p && p !== '.' && !p.startsWith('..'));
        debug.rels = rels;
        const args = ['diff', '--no-color', '--unified=0', range];
        if (rels.length) args.push('--', ...rels);
        debug.firstArgs = args;
        let output = runDiff(args);
        debug.firstOutLen = output.length;
        debug.firstOutSample = output.slice(0, 500);
        parseDiff(output);
        if (Object.keys(map).length === 0) {
            // fallback: 不限制路径
            const argsAll = ['diff', '--no-color', '--unified=0', range];
            debug.allArgs = argsAll;
            output = runDiff(argsAll);
            debug.allOutLen = output.length;
            debug.allOutSample = output.slice(0, 500);
            parseDiff(output);
        }
        if (Object.keys(map).length === 0) {
            // fallback2: 不带 range，直接对工作区/staged 取 diff
            const fallbackArgs = ['diff', '--no-color', '--unified=0'];
            if (rels.length) fallbackArgs.push('--', ...rels);
            debug.fallbackArgs = fallbackArgs;
            const outFallback = runDiff(fallbackArgs);
            debug.fallbackOutLen = outFallback.length;
            debug.fallbackOutSample = outFallback.slice(0, 500);
            parseDiff(outFallback);
        }
    } catch (err) {
        // ignore, return map (possibly empty)
    }
    map.__debug = debug;
    return map;
}

