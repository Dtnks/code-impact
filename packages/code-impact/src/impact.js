import path from 'path';
import { loadGraph, detectNodeType } from './graph.js';

function normalizeId(p, projectRoot) {
    if (typeof p !== 'string') return p;
    if (p.startsWith('pkg:')) return p;
    const abs = path.resolve(p);
    if (projectRoot) {
        const root = path.resolve(projectRoot);
        if (abs.startsWith(root)) {
            const rel = path.relative(root, abs);
            return rel || '.';
        }
    }
    return abs;
}

function normalizeSet(items = [], projectRoot) {
    return new Set(items.map((p) => normalizeId(p, projectRoot)));
}

export function traverseImpact(graph, startFiles, { includeDynamic = true, depth = Infinity } = {}) {
    const projectRoot = graph.meta?.projectRoot;
    const seeds = normalizeSet(startFiles, projectRoot);
    const visited = new Map();
    const queue = [];
    const edgeMap = new Map(); // key: from=>to
    const seedList = Array.from(seeds);

    // 确保有反向邻接：老版本 graph 可能没有 reverse，按 edges 构建一次
    let reverse = graph.reverse;
    if (!reverse || typeof reverse !== 'object') {
        reverse = {};
        (graph.edges || []).forEach((e) => {
            if (!e || !e.to || !e.from) return;
            if (!reverse[e.to]) reverse[e.to] = [];
            reverse[e.to].push({ from: e.from, to: e.to, kind: e.kind, dynamic: e.dynamic });
        });
    }

    seeds.forEach((id) => {
        visited.set(id, 0);
        queue.push(id);
    });

    while (queue.length) {
        const current = queue.shift();
        const curDepth = visited.get(current);
        if (curDepth >= depth) continue;
        const incoming = reverse[current] || [];
        for (const edge of incoming) {
            if (!includeDynamic && edge.dynamic) continue;
            const to = edge.to || current; // 旧版本 reverse 缺少 to 字段
            const next = edge.from;
            const key = `${edge.from}=>${to}`;
            if (!edgeMap.has(key)) {
                edgeMap.set(key, { from: edge.from, to, kind: edge.kind, dynamic: edge.dynamic });
            }
            if (!visited.has(next)) {
                visited.set(next, curDepth + 1);
                queue.push(next);
            }
        }
    }

    const results = [];
    for (const [id, dist] of visited.entries()) {
        if (seeds.has(id)) continue;
        results.push({ id, distance: dist, type: detectNodeType(id) });
    }
    results.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
    return { results, edges: Array.from(edgeMap.values()), seeds: seedList };
}

export async function impactFromGraph({
    projectRoot = process.cwd(),
    files = [],
    includeDynamic = true,
    depth,
}) {
    const graph = await loadGraph(projectRoot);
    return traverseImpact(graph, files, { includeDynamic, depth: depth ?? Infinity });
}

