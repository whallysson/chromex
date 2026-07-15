import { existsSync, readFileSync, statSync } from 'fs';
import { resolveChromexPath } from './artifacts.mjs';

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

export class HeapAnalysisStore {
  constructor() {
    this.models = new Map();
  }

  execute(action, args = {}) {
    if (action === 'close') return this.close(args.filePath);
    if (action === 'compare') return this.compare(args.filePath, args.otherFilePath, args.limit);
    const model = this.load(args.filePath);
    if (action === 'summary') return model.summary(args.limit);
    if (action === 'details') return model.details(args.node);
    if (action === 'class-nodes') return model.classNodes(args.className, args.limit);
    if (action === 'dominators') return model.dominators(args.node, args.limit);
    if (action === 'duplicate-strings') return model.duplicateStrings(args.limit);
    if (action === 'edges') return model.edges(args.node, args.limit);
    if (action === 'retainers') return model.retainers(args.node, args.limit);
    if (action === 'retaining-paths') return model.retainingPaths(args.node, args.limit, args.depth);
    throw new Error(`Unknown heap analysis action: ${action}`);
  }

  load(filePath) {
    if (!filePath) throw new Error('Heap snapshot file required.');
    const path = resolveChromexPath(filePath);
    if (this.models.has(path)) return this.models.get(path);
    if (!existsSync(path)) throw new Error(`Heap snapshot not found: ${path}`);
    const size = statSync(path).size;
    const maxBytes = Number(process.env.CHROMEX_HEAP_MAX_BYTES) || DEFAULT_MAX_BYTES;
    if (size > maxBytes) throw new Error(`Heap snapshot is ${formatBytes(size)}, above the ${formatBytes(maxBytes)} analysis limit. Set CHROMEX_HEAP_MAX_BYTES explicitly to raise it.`);
    const snapshot = JSON.parse(readFileSync(path, 'utf8'));
    const model = new HeapModel(path, snapshot, size);
    this.models.set(path, model);
    while (this.models.size > 2) this.models.delete(this.models.keys().next().value);
    return model;
  }

  close(filePath) {
    if (!filePath) {
      const closed = this.models.size;
      this.models.clear();
      return { text: `Closed ${closed} heap analysis cache(s).`, data: { closed } };
    }
    const path = resolveChromexPath(filePath);
    const closed = this.models.delete(path) ? 1 : 0;
    return { text: closed ? `Closed heap analysis cache for ${path}.` : `Heap analysis cache was not open: ${path}`, data: { closed, path } };
  }

  compare(firstPath, secondPath, limit = 30) {
    if (!firstPath || !secondPath) throw new Error('Two heap snapshot files are required for compare.');
    const first = this.load(firstPath);
    const second = this.load(secondPath);
    const before = first.classSummary();
    const after = second.classSummary();
    const names = new Set([...before.keys(), ...after.keys()]);
    const changes = [...names].map(name => {
      const a = before.get(name) || { count: 0, selfSize: 0 };
      const b = after.get(name) || { count: 0, selfSize: 0 };
      return { name, countDelta: b.count - a.count, sizeDelta: b.selfSize - a.selfSize, before: a, after: b };
    }).filter(item => item.countDelta || item.sizeDelta).sort((a, b) => Math.abs(b.sizeDelta) - Math.abs(a.sizeDelta)).slice(0, clampLimit(limit));
    const lines = [`Heap comparison: ${first.path} -> ${second.path}`, `Node delta: ${second.nodeCount - first.nodeCount}`, `Self-size delta: ${formatSignedBytes(second.totalSelfSize() - first.totalSelfSize())}`];
    for (const item of changes) lines.push(`  ${formatSignedBytes(item.sizeDelta).padStart(10)} ${formatSigned(item.countDelta).padStart(8)}  ${item.name}`);
    return { text: lines.join('\n'), data: { first: first.metadata(), second: second.metadata(), changes } };
  }
}

class HeapModel {
  constructor(path, snapshot, fileSize) {
    this.path = path;
    this.snapshot = snapshot;
    this.fileSize = fileSize;
    this.nodes = snapshot.nodes || [];
    this.edgeValues = snapshot.edges || [];
    this.strings = snapshot.strings || [];
    this.nodeFields = snapshot.snapshot?.meta?.node_fields || [];
    this.edgeFields = snapshot.snapshot?.meta?.edge_fields || [];
    this.nodeTypes = snapshot.snapshot?.meta?.node_types?.[this.nodeFields.indexOf('type')] || [];
    this.edgeTypes = snapshot.snapshot?.meta?.edge_types?.[this.edgeFields.indexOf('type')] || [];
    this.nodeWidth = this.nodeFields.length;
    this.edgeWidth = this.edgeFields.length;
    if (!this.nodeWidth || !this.edgeWidth) throw new Error('Invalid Chrome heap snapshot metadata.');
    this.nodeCount = Math.floor(this.nodes.length / this.nodeWidth);
    this.edgeCount = Math.floor(this.edgeValues.length / this.edgeWidth);
    this.nodeField = Object.fromEntries(this.nodeFields.map((name, index) => [name, index]));
    this.edgeField = Object.fromEntries(this.edgeFields.map((name, index) => [name, index]));
    this.edgeStarts = new Uint32Array(this.nodeCount + 1);
    let cursor = 0;
    for (let index = 0; index < this.nodeCount; index++) {
      this.edgeStarts[index] = cursor;
      cursor += this.rawNode(index, 'edge_count') || 0;
    }
    this.edgeStarts[this.nodeCount] = cursor;
    this.reverse = null;
    this.dominatorState = null;
    this.classSummaryCache = null;
  }

  metadata() {
    return { path: this.path, fileSize: this.fileSize, nodes: this.nodeCount, edges: this.edgeCount, selfSize: this.totalSelfSize() };
  }

  summary(limit = 30) {
    const byType = new Map();
    for (let index = 0; index < this.nodeCount; index++) {
      const node = this.node(index);
      const value = byType.get(node.type) || { count: 0, selfSize: 0 };
      value.count++;
      value.selfSize += node.selfSize;
      byType.set(node.type, value);
    }
    const classes = [...this.classSummary().entries()].map(([name, value]) => ({ name, ...value })).sort((a, b) => b.selfSize - a.selfSize).slice(0, clampLimit(limit));
    const lines = [`Heap snapshot: ${this.path}`, `File: ${formatBytes(this.fileSize)} Nodes: ${this.nodeCount} Edges: ${this.edgeCount} Self size: ${formatBytes(this.totalSelfSize())}`, 'Types:'];
    for (const [type, value] of [...byType.entries()].sort((a, b) => b[1].selfSize - a[1].selfSize)) lines.push(`  ${formatBytes(value.selfSize).padStart(10)} ${String(value.count).padStart(9)}  ${type}`);
    lines.push('Top classes:');
    for (const item of classes) lines.push(`  ${formatBytes(item.selfSize).padStart(10)} ${String(item.count).padStart(9)}  ${item.name}`);
    return { text: lines.join('\n'), data: { ...this.metadata(), types: Object.fromEntries(byType), classes } };
  }

  details(identifier) {
    const index = this.resolveNode(identifier);
    const node = this.node(index);
    const outgoing = this.outgoing(index, 30);
    const incoming = this.incoming(index, 30);
    const data = { ...node, outgoing, retainers: incoming };
    const lines = [`Heap node #${index} id=${node.id} ${node.type} ${node.name}`, `Self size: ${formatBytes(node.selfSize)} Edges: ${node.edgeCount} Retainers: ${incoming.length}`, 'Outgoing:'];
    for (const edge of outgoing) lines.push(`  ${edge.type} ${edge.name} -> #${edge.toNode} ${edge.toType} ${edge.toName}`);
    lines.push('Retainers:');
    for (const edge of incoming) lines.push(`  #${edge.fromNode} ${edge.fromType} ${edge.fromName} via ${edge.type} ${edge.name}`);
    return { text: lines.join('\n'), data };
  }

  classNodes(className, limit = 50) {
    if (!className) throw new Error('Class name required.');
    const query = String(className).toLowerCase();
    const matches = [];
    for (let index = 0; index < this.nodeCount; index++) {
      const node = this.node(index);
      if (node.name.toLowerCase().includes(query)) matches.push(node);
    }
    matches.sort((a, b) => b.selfSize - a.selfSize);
    const selected = matches.slice(0, clampLimit(limit));
    const lines = [`Heap class nodes matching "${className}": ${matches.length}`];
    for (const node of selected) lines.push(`  #${node.index} id=${node.id} ${formatBytes(node.selfSize).padStart(9)} ${node.type} ${node.name}`);
    return { text: lines.join('\n'), data: { query: className, total: matches.length, nodes: selected } };
  }

  dominators(identifier, limit = 30) {
    const state = this.buildDominators();
    if (identifier != null && identifier !== '') {
      const index = this.resolveNode(identifier);
      const children = [];
      for (let candidate = 0; candidate < this.nodeCount; candidate++) {
        if (candidate !== index && state.idom[candidate] === index) children.push({ ...this.node(candidate), retainedSize: state.retained[candidate] });
      }
      children.sort((a, b) => b.retainedSize - a.retainedSize);
      const selected = children.slice(0, clampLimit(limit));
      const lines = [`Immediate dominator children for #${index}: ${children.length}`];
      for (const node of selected) lines.push(`  #${node.index} retained=${formatBytes(node.retainedSize)} self=${formatBytes(node.selfSize)} ${node.type} ${node.name}`);
      return { text: lines.join('\n'), data: { node: this.node(index), children: selected } };
    }
    const nodes = [];
    for (let index = 1; index < this.nodeCount; index++) nodes.push({ ...this.node(index), retainedSize: state.retained[index], dominator: state.idom[index] });
    nodes.sort((a, b) => b.retainedSize - a.retainedSize);
    const selected = nodes.slice(0, clampLimit(limit));
    const lines = [`Top dominators: ${selected.length}`];
    for (const node of selected) lines.push(`  #${node.index} retained=${formatBytes(node.retainedSize)} self=${formatBytes(node.selfSize)} ${node.type} ${node.name}`);
    return { text: lines.join('\n'), data: { dominators: selected } };
  }

  duplicateStrings(limit = 50) {
    const groups = new Map();
    for (let index = 0; index < this.nodeCount; index++) {
      const node = this.node(index);
      if (!node.type.includes('string') || !node.name) continue;
      const value = groups.get(node.name) || { value: node.name, count: 0, selfSize: 0, nodes: [] };
      value.count++;
      value.selfSize += node.selfSize;
      if (value.nodes.length < 20) value.nodes.push(index);
      groups.set(node.name, value);
    }
    const duplicates = [...groups.values()].filter(item => item.count > 1).sort((a, b) => b.selfSize - a.selfSize).slice(0, clampLimit(limit));
    const lines = [`Duplicate strings: ${duplicates.length}`];
    for (const item of duplicates) lines.push(`  ${formatBytes(item.selfSize).padStart(9)} x${String(item.count).padStart(5)} ${JSON.stringify(item.value.slice(0, 120))}`);
    return { text: lines.join('\n'), data: { duplicates } };
  }

  edges(identifier, limit = 50) {
    const index = this.resolveNode(identifier);
    const edges = this.outgoing(index, clampLimit(limit));
    const lines = [`Outgoing edges for #${index}: ${this.node(index).edgeCount}`];
    for (const edge of edges) lines.push(`  ${edge.type} ${edge.name} -> #${edge.toNode} ${edge.toType} ${edge.toName}`);
    return { text: lines.join('\n'), data: { node: this.node(index), edges } };
  }

  retainers(identifier, limit = 50) {
    const index = this.resolveNode(identifier);
    const retainers = this.incoming(index, clampLimit(limit));
    const lines = [`Retainers for #${index}: ${this.reverseCount(index)}`];
    for (const edge of retainers) lines.push(`  #${edge.fromNode} ${edge.fromType} ${edge.fromName} via ${edge.type} ${edge.name}`);
    return { text: lines.join('\n'), data: { node: this.node(index), retainers } };
  }

  retainingPaths(identifier, limit = 5, depth = 20) {
    const index = this.resolveNode(identifier);
    const maxPaths = Math.max(1, Math.min(20, Number(limit) || 5));
    const maxDepth = Math.max(1, Math.min(100, Number(depth) || 20));
    const queue = [[index]];
    const paths = [];
    let cursor = 0;
    while (cursor < queue.length && paths.length < maxPaths) {
      const path = queue[cursor++];
      const current = path[path.length - 1];
      if (current === 0 || this.node(current).type === 'synthetic') {
        paths.push(path);
        continue;
      }
      if (path.length >= maxDepth) {
        paths.push(path);
        continue;
      }
      for (const edge of this.incoming(current, 100)) {
        if (edge.type === 'weak' || path.includes(edge.fromNode)) continue;
        queue.push([...path, edge.fromNode]);
        if (queue.length > 10000) break;
      }
    }
    const normalized = paths.map(path => path.map(nodeIndex => this.node(nodeIndex)));
    const lines = [`Retaining paths for #${index}: ${normalized.length}`];
    for (const [pathIndex, path] of normalized.entries()) lines.push(`  [${pathIndex}] ${path.map(node => `#${node.index} ${node.name || node.type}`).join(' <- ')}`);
    return { text: lines.join('\n'), data: { node: this.node(index), paths: normalized, truncated: queue.length > cursor } };
  }

  classSummary() {
    if (this.classSummaryCache) return this.classSummaryCache;
    const groups = new Map();
    for (let index = 0; index < this.nodeCount; index++) {
      const node = this.node(index);
      const name = node.name || `(${node.type})`;
      const value = groups.get(name) || { count: 0, selfSize: 0 };
      value.count++;
      value.selfSize += node.selfSize;
      groups.set(name, value);
    }
    this.classSummaryCache = groups;
    return groups;
  }

  totalSelfSize() {
    let total = 0;
    for (let index = 0; index < this.nodeCount; index++) total += this.rawNode(index, 'self_size') || 0;
    return total;
  }

  node(index) {
    const typeIndex = this.rawNode(index, 'type');
    return {
      index,
      type: this.nodeTypes[typeIndex] || String(typeIndex),
      name: this.strings[this.rawNode(index, 'name')] || '',
      id: this.rawNode(index, 'id'),
      selfSize: this.rawNode(index, 'self_size') || 0,
      edgeCount: this.rawNode(index, 'edge_count') || 0,
      detachedness: this.rawNode(index, 'detachedness') || 0,
    };
  }

  rawNode(index, field) {
    const position = this.nodeField[field];
    return position == null ? 0 : this.nodes[index * this.nodeWidth + position];
  }

  edge(edgeIndex) {
    const offset = edgeIndex * this.edgeWidth;
    const typeIndex = this.edgeValues[offset + this.edgeField.type];
    const type = this.edgeTypes[typeIndex] || String(typeIndex);
    const rawName = this.edgeValues[offset + this.edgeField.name_or_index];
    const name = ['element', 'hidden'].includes(type) ? String(rawName) : this.strings[rawName] || String(rawName);
    const targetOffset = this.edgeValues[offset + this.edgeField.to_node];
    return { type, name, toNode: Math.floor(targetOffset / this.nodeWidth) };
  }

  outgoing(index, limit = Infinity) {
    const edges = [];
    for (let edgeIndex = this.edgeStarts[index]; edgeIndex < this.edgeStarts[index + 1] && edges.length < limit; edgeIndex++) {
      const edge = this.edge(edgeIndex);
      const target = this.node(edge.toNode);
      edges.push({ ...edge, edgeIndex, toType: target.type, toName: target.name });
    }
    return edges;
  }

  incoming(index, limit = Infinity) {
    this.buildReverse();
    const edges = [];
    for (let position = this.reverse.offsets[index]; position < this.reverse.offsets[index + 1] && edges.length < limit; position++) {
      const source = this.reverse.sources[position];
      const edge = this.edge(this.reverse.edgeIndexes[position]);
      const node = this.node(source);
      edges.push({ ...edge, fromNode: source, fromType: node.type, fromName: node.name });
    }
    return edges;
  }

  reverseCount(index) {
    this.buildReverse();
    return this.reverse.offsets[index + 1] - this.reverse.offsets[index];
  }

  buildReverse() {
    if (this.reverse) return this.reverse;
    const counts = new Uint32Array(this.nodeCount);
    for (let edgeIndex = 0; edgeIndex < this.edgeCount; edgeIndex++) {
      const target = this.edge(edgeIndex).toNode;
      if (target < this.nodeCount) counts[target]++;
    }
    const offsets = new Uint32Array(this.nodeCount + 1);
    for (let index = 0; index < this.nodeCount; index++) offsets[index + 1] = offsets[index] + counts[index];
    const cursor = offsets.slice(0, this.nodeCount);
    const sources = new Uint32Array(this.edgeCount);
    const edgeIndexes = new Uint32Array(this.edgeCount);
    for (let source = 0; source < this.nodeCount; source++) {
      for (let edgeIndex = this.edgeStarts[source]; edgeIndex < this.edgeStarts[source + 1]; edgeIndex++) {
        const target = this.edge(edgeIndex).toNode;
        const position = cursor[target]++;
        sources[position] = source;
        edgeIndexes[position] = edgeIndex;
      }
    }
    this.reverse = { offsets, sources, edgeIndexes };
    return this.reverse;
  }

  buildDominators() {
    if (this.dominatorState) return this.dominatorState;
    this.buildReverse();
    const visited = new Uint8Array(this.nodeCount);
    const postorder = [];
    const stack = [{ node: 0, edge: this.edgeStarts[0] }];
    visited[0] = 1;
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (frame.edge < this.edgeStarts[frame.node + 1]) {
        const edge = this.edge(frame.edge++);
        if (edge.type === 'weak' || visited[edge.toNode]) continue;
        visited[edge.toNode] = 1;
        stack.push({ node: edge.toNode, edge: this.edgeStarts[edge.toNode] });
      } else {
        postorder.push(frame.node);
        stack.pop();
      }
    }
    const rpo = postorder.reverse();
    const order = new Int32Array(this.nodeCount);
    order.fill(-1);
    for (let index = 0; index < rpo.length; index++) order[rpo[index]] = index;
    const idom = new Int32Array(this.nodeCount);
    idom.fill(-1);
    idom[0] = 0;
    let changed = true;
    let iterations = 0;
    while (changed && iterations++ < 100) {
      changed = false;
      for (let rpoIndex = 1; rpoIndex < rpo.length; rpoIndex++) {
        const node = rpo[rpoIndex];
        let candidate = -1;
        for (let position = this.reverse.offsets[node]; position < this.reverse.offsets[node + 1]; position++) {
          const edgeIndex = this.reverse.edgeIndexes[position];
          if (this.edge(edgeIndex).type === 'weak') continue;
          const predecessor = this.reverse.sources[position];
          if (idom[predecessor] < 0) continue;
          candidate = candidate < 0 ? predecessor : intersect(candidate, predecessor, idom, order);
        }
        if (candidate >= 0 && idom[node] !== candidate) {
          idom[node] = candidate;
          changed = true;
        }
      }
    }
    const retained = new Float64Array(this.nodeCount);
    for (let index = 0; index < this.nodeCount; index++) retained[index] = this.rawNode(index, 'self_size') || 0;
    for (let index = rpo.length - 1; index > 0; index--) {
      const node = rpo[index];
      if (idom[node] >= 0 && idom[node] !== node) retained[idom[node]] += retained[node];
    }
    this.dominatorState = { idom, retained, rpo, iterations };
    return this.dominatorState;
  }

  resolveNode(identifier) {
    if (identifier == null || identifier === '') throw new Error('Heap node index or id required.');
    const text = String(identifier);
    if (text.startsWith('id:')) {
      const id = Number(text.slice(3));
      for (let index = 0; index < this.nodeCount; index++) if (this.rawNode(index, 'id') === id) return index;
      throw new Error(`Heap node id not found: ${id}`);
    }
    const index = Number(text.replace(/^#/, ''));
    if (!Number.isInteger(index) || index < 0 || index >= this.nodeCount) throw new Error(`Heap node index out of range: ${identifier}`);
    return index;
  }
}

function intersect(first, second, idom, order) {
  let left = first;
  let right = second;
  while (left !== right) {
    while (order[left] > order[right]) left = idom[left];
    while (order[right] > order[left]) right = idom[right];
  }
  return left;
}

function clampLimit(value) {
  return Math.max(1, Math.min(500, Number(value) || 30));
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

function formatSignedBytes(value) {
  return `${value >= 0 ? '+' : '-'}${formatBytes(Math.abs(value))}`;
}

function formatSigned(value) {
  return `${value >= 0 ? '+' : ''}${value}`;
}
