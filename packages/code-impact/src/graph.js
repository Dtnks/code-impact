import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import fg from 'fast-glob';
import { parse } from '@typescript-eslint/typescript-estree';
import postcss from 'postcss';
import safeParser from 'postcss-safe-parser';
import { loadWebpackResolve } from './resolvers/webpack.js';

const CODE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue'];
const STYLE_EXTS = ['.css', '.scss', '.less'];
const ASSET_EXTS = ['.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.mp4', '.json'];
const DEFAULT_EXTS = [...CODE_EXTS, ...STYLE_EXTS, ...ASSET_EXTS];
const IGNORE_GLOBS = ['**/node_modules/**', '**/dist/**', '**/.git/**', '**/.next/**', '**/.cache/**', '**/coverage/**', '**/build/**', '**/.code-impact/**', '**/.impact.mmd'];

const NodeType = {
    CODE: 'code',
    STYLE: 'style',
    ASSET: 'asset',
    PKG: 'pkg',
};

export function detectNodeType(filePath) {
    if (filePath.startsWith('pkg:')) return NodeType.PKG;
    const ext = path.extname(filePath).toLowerCase();
    if (STYLE_EXTS.includes(ext)) return NodeType.STYLE;
    if (ASSET_EXTS.includes(ext)) return NodeType.ASSET;
    return NodeType.CODE;
}

function normalize(p) {
    return path.resolve(p);
}

function fileExists(p) {
    try {
        return fs.statSync(p).isFile();
    } catch {
        return false;
    }
}

function dirExists(p) {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

function ensureDir(p) {
    return fsp.mkdir(p, { recursive: true });
}

function tryResolveWithExt(basePath, extensions) {
    if (fileExists(basePath)) return basePath;
    const ext = path.extname(basePath);
    if (ext && fileExists(basePath)) return basePath;
    for (const ex of extensions) {
        const cand = basePath + ex;
        if (fileExists(cand)) return cand;
    }
    if (dirExists(basePath)) {
        for (const ex of extensions) {
            const cand = path.join(basePath, `index${ex}`);
            if (fileExists(cand)) return cand;
        }
    }
    return null;
}

function resolveWithAlias(spec, fromFile, { projectRoot, alias, extensions }) {
    const fromDir = path.dirname(fromFile);
    if (spec.startsWith('.') || spec.startsWith('/')) {
        const targetBase = spec.startsWith('/')
            ? path.join(projectRoot, spec)
            : path.resolve(fromDir, spec);
        const resolved = tryResolveWithExt(targetBase, extensions);
        if (resolved) return resolved;
    }

    let aliased = null;
    if (alias && Object.keys(alias).length > 0) {
        const keys = Object.keys(alias).sort((a, b) => b.length - a.length);
        for (const key of keys) {
            if (spec === key || spec.startsWith(`${key}/`)) {
                const rest = spec.slice(key.length);
                const base = path.resolve(projectRoot, alias[key], rest);
                const resolved = tryResolveWithExt(base, extensions);
                if (resolved) {
                    aliased = resolved;
                    break;
                }
            }
        }
        if (aliased) return aliased;
    }

    // package import
    return `pkg:${spec}`;
}

function collectCodeEdges(ast, fromFile) {
    const deps = [];
    const stack = [ast];
    while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node !== 'object') continue;

        if (node.type === 'ImportDeclaration' && node.source?.value) {
            deps.push({ spec: node.source.value, kind: 'import', dynamic: false });
        }
        if (node.type === 'ExportAllDeclaration' && node.source?.value) {
            deps.push({ spec: node.source.value, kind: 'import', dynamic: false });
        }
        if (node.type === 'CallExpression' && node.callee?.name === 'require' && node.arguments?.length === 1) {
            const arg = node.arguments[0];
            if (arg.type === 'Literal' && typeof arg.value === 'string') {
                deps.push({ spec: arg.value, kind: 'import', dynamic: false });
            }
        }
        if (node.type === 'ImportExpression' && node.source) {
            if (node.source.type === 'Literal' && typeof node.source.value === 'string') {
                deps.push({ spec: node.source.value, kind: 'dynamic', dynamic: true });
            }
        }

        for (const key of Object.keys(node)) {
            const child = node[key];
            if (Array.isArray(child)) {
                for (let i = child.length - 1; i >= 0; i -= 1) {
                    stack.push(child[i]);
                }
            } else if (child && typeof child === 'object') {
                stack.push(child);
            }
        }
    }
    return deps;
}

async function parseCssDeps(code, fromFile) {
    const results = [];
    const root = postcss().process(code, { from: fromFile, parser: safeParser }).root;
    root.walkAtRules('import', (rule) => {
        const param = rule.params.replace(/['"]/g, '').replace(/url\(|\)/g, '').trim();
        if (param) results.push({ spec: param, kind: 'style', dynamic: false });
    });
    root.walkDecls((decl) => {
        const matches = decl.value.match(/url\(([^)]+)\)/g);
        if (matches) {
            matches.forEach((m) => {
                const inner = m.replace(/url\(|\)/g, '').replace(/['"]/g, '').trim();
                if (inner && !inner.startsWith('data:')) {
                    results.push({ spec: inner, kind: 'asset', dynamic: false });
                }
            });
        }
    });
    return results;
}

function parseAttrs(raw = '') {
    const attrs = {};
    const re = /(\w+)(?:\s*=\s*("(.*?)"|'(.*?)'|[^\s"'>]+))?/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
        const key = m[1];
        const val = m[3] || m[4] || (m[2] ? m[2] : '');
        if (key) attrs[key] = val;
    }
    return attrs;
}

function parseVueSfc(content) {
    const scripts = [];
    const scriptSrc = [];
    const styles = [];
    const styleSrc = [];

    const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let sm;
    while ((sm = scriptRe.exec(content)) !== null) {
        const attrs = parseAttrs(sm[1] || '');
        if (attrs.src) {
            scriptSrc.push(attrs.src.trim());
        }
        const body = sm[2] || '';
        if (body.trim()) scripts.push(body);
    }

    const styleRe = /<style\b([^>]*)>([\s\S]*?)<\/style>/gi;
    let stm;
    while ((stm = styleRe.exec(content)) !== null) {
        const attrs = parseAttrs(stm[1] || '');
        if (attrs.src) {
            styleSrc.push(attrs.src.trim());
        }
        const body = stm[2] || '';
        if (body.trim()) styles.push(body);
    }

    return { scripts, scriptSrc, styles, styleSrc };
}

export async function buildGraph({
    projectRoot = process.cwd(),
    roots,
    webpackConfig,
    exts = DEFAULT_EXTS,
}) {
    const graph = {
        meta: { projectRoot: normalize(projectRoot), generatedAt: new Date().toISOString() },
        nodes: {},
        edges: [],
        forward: {},
        reverse: {},
        errors: [],
    };

    const resolvedRoots = [];
    if (Array.isArray(roots) && roots.length > 0) {
        roots.forEach((r) => {
            const abs = path.resolve(projectRoot, r);
            if (dirExists(abs)) resolvedRoots.push(abs);
        });
    } else {
        const defaultRoot = path.join(projectRoot, 'src');
        if (dirExists(defaultRoot)) resolvedRoots.push(defaultRoot);
        const pkgRoots = await fg(['packages/*/src'], { cwd: projectRoot, onlyDirectories: true, absolute: true, ignore: IGNORE_GLOBS });
        resolvedRoots.push(...pkgRoots);
    }

    if (resolvedRoots.length === 0) {
        throw new Error('未找到可用的源码目录，请检查 roots 或项目结构。');
    }

    const webpackResolve = await loadWebpackResolve({ projectRoot, webpackConfig });
    const alias = webpackResolve.alias || {};
    const extensions = webpackResolve.extensions?.length ? webpackResolve.extensions : exts;

    const files = new Set();
    for (const root of resolvedRoots) {
        const found = await fg(['**/*.{ts,tsx,js,jsx,mjs,cjs,vue,css,scss,less,svg,png,jpg,jpeg,gif,webp,avif,mp4,json}'], {
            cwd: root,
            absolute: true,
            ignore: IGNORE_GLOBS,
        });
        found.forEach((f) => files.add(normalize(f)));
    }

    const addNode = (id) => {
        if (graph.nodes[id]) return;
        graph.nodes[id] = { id, type: detectNodeType(id) };
    };
    const addEdge = (from, to, kind, dynamic = false) => {
        graph.edges.push({ from, to, kind, dynamic });
        if (!graph.forward[from]) graph.forward[from] = [];
        graph.forward[from].push({ to, kind, dynamic });
        if (!graph.reverse[to]) graph.reverse[to] = [];
        graph.reverse[to].push({ from, kind, dynamic });
    };

    // pre-register nodes
    files.forEach(addNode);

    for (const file of files) {
        const type = detectNodeType(file);
        let content = '';
        try {
            content = await fsp.readFile(file, 'utf8');
        } catch (err) {
            graph.errors.push({ file, error: err.message });
            continue;
        }

        if (type === NodeType.CODE) {
            const isVue = path.extname(file).toLowerCase() === '.vue';
            if (isVue) {
                const { scripts, scriptSrc, styles, styleSrc } = parseVueSfc(content);
                // external script src
                scriptSrc.forEach((spec) => {
                    const target = resolveWithAlias(spec, file, { projectRoot, alias, extensions });
                    addNode(target);
                    const kind = detectNodeType(target) === NodeType.PKG ? 'pkg' : 'import';
                    addEdge(file, target, kind, false);
                });
                // inline scripts
                for (const block of scripts) {
                    try {
                        const ast = parse(block, {
                            jsx: true,
                            loc: false,
                            range: false,
                            sourceType: 'module',
                            ecmaVersion: 'latest',
                        });
                        const deps = collectCodeEdges(ast, file);
                        for (const dep of deps) {
                            const target = resolveWithAlias(dep.spec, file, { projectRoot, alias, extensions });
                            addNode(target);
                            const kind = detectNodeType(target) === NodeType.PKG ? 'pkg' : dep.kind;
                            addEdge(file, target, kind, dep.dynamic);
                        }
                    } catch (err) {
                        graph.errors.push({ file, error: `parse vue <script> failed: ${err.message}` });
                    }
                }
                // external styles
                styleSrc.forEach((spec) => {
                    const target = resolveWithAlias(spec, file, { projectRoot, alias, extensions });
                    addNode(target);
                    addEdge(file, target, 'style', false);
                });
                // inline styles
                for (const block of styles) {
                    const deps = await parseCssDeps(block, file);
                    for (const dep of deps) {
                        const target = resolveWithAlias(dep.spec, file, { projectRoot, alias, extensions });
                        addNode(target);
                        addEdge(file, target, dep.kind, dep.dynamic);
                    }
                }
                continue;
            }
            let ast;
            try {
                ast = parse(content, {
                    jsx: true,
                    loc: false,
                    range: false,
                    sourceType: 'module',
                    ecmaVersion: 'latest',
                });
            } catch (err) {
                graph.errors.push({ file, error: `parse failed: ${err.message}` });
                continue;
            }
            const deps = collectCodeEdges(ast, file);
            for (const dep of deps) {
                const target = resolveWithAlias(dep.spec, file, { projectRoot, alias, extensions });
                addNode(target);
                const kind = detectNodeType(target) === NodeType.PKG ? 'pkg' : dep.kind;
                addEdge(file, target, kind, dep.dynamic);
            }
        } else if (type === NodeType.STYLE) {
            const deps = await parseCssDeps(content, file);
            for (const dep of deps) {
                const target = resolveWithAlias(dep.spec, file, { projectRoot, alias, extensions });
                addNode(target);
                addEdge(file, target, dep.kind, dep.dynamic);
            }
        }
    }

    return relativizeGraph(graph);
}

function relativizeId(id, projectRoot) {
    if (id.startsWith('pkg:')) return id;
    const absRoot = normalize(projectRoot);
    const abs = normalize(id);
    if (abs.startsWith(absRoot)) {
        const rel = path.relative(absRoot, abs);
        return rel || '.';
    }
    return id;
}

function relativizeGraph(graph) {
    const projectRoot = graph.meta?.projectRoot || process.cwd();
    const map = new Map();
    Object.keys(graph.nodes).forEach((id) => {
        map.set(id, relativizeId(id, projectRoot));
    });
    const remapNode = (id) => map.get(id) || id;

    const nodes = {};
    Object.values(graph.nodes).forEach((n) => {
        const newId = remapNode(n.id);
        nodes[newId] = { ...n, id: newId };
    });

    const edges = (graph.edges || []).map((e) => ({
        ...e,
        from: remapNode(e.from),
        to: remapNode(e.to),
    }));

    const forward = {};
    Object.entries(graph.forward || {}).forEach(([from, list]) => {
        const nf = remapNode(from);
        forward[nf] = (list || []).map((e) => ({
            ...e,
            to: remapNode(e.to),
        }));
    });

    const reverse = {};
    Object.entries(graph.reverse || {}).forEach(([to, list]) => {
        const nt = remapNode(to);
        reverse[nt] = (list || []).map((e) => ({
            ...e,
            from: remapNode(e.from),
            to: remapNode(e.to || to),
        }));
    });

    const errors = (graph.errors || []).map((er) => ({
        ...er,
        file: er.file ? relativizeId(er.file, projectRoot) : er.file,
    }));

    return { ...graph, nodes, edges, forward, reverse, errors };
}

export async function saveGraph(graph, projectRoot = process.cwd()) {
    const outDir = path.join(projectRoot, '.code-impact');
    await ensureDir(outDir);
    const file = path.join(outDir, 'graph.txt');
    await fsp.writeFile(file, JSON.stringify(graph, null, 2), 'utf8');
    return file;
}

export async function loadGraph(projectRoot = process.cwd()) {
    const file = path.join(projectRoot, '.code-impact', 'graph.txt');
    const raw = await fsp.readFile(file, 'utf8');
    return JSON.parse(raw);
}

