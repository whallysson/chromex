// Accessibility tree snapshot with incremental diff and interactive refs (@e1, @e2...)

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
  'menuitem', 'tab', 'switch', 'searchbox', 'slider', 'spinbutton',
  'option', 'menuitemcheckbox', 'menuitemradio', 'treeitem',
]);

// Check if AX node is marked as ignored/hidden by the browser
function isAxNodeHidden(node) {
  if (node.ignored) return true;
  // CDP includes boolean properties like 'hidden' in the properties array
  const hidden = node.properties?.find(p => p.name === 'hidden');
  if (hidden?.value?.value === true) return true;
  return false;
}

function shouldShowAxNode(node, compact = false) {
  if (isAxNodeHidden(node)) return false;
  const role = node.role?.value || '';
  const name = node.name?.value ?? '';
  const value = node.value?.value;
  if (compact && role === 'InlineTextBox') return false;
  return role !== 'none' && role !== 'generic' && !(name === '' && (value === '' || value == null));
}

// Check if element is focusable/clickable (not disabled, not aria-disabled)
function isAxNodeInteractable(node) {
  const disabled = node.properties?.find(p => p.name === 'disabled');
  if (disabled?.value?.value === true) return false;
  return true;
}

const MAX_NAME_LENGTH = 200;

function truncate(str, max = MAX_NAME_LENGTH) {
  if (!str || str.length <= max) return str;
  return str.slice(0, max) + '...';
}

function formatAxNode(node, depth, refIndex, refs) {
  const role = node.role?.value || '';
  const name = truncate(node.name?.value ?? '');
  const value = node.value?.value;
  const indent = '  '.repeat(Math.min(depth, 10));

  let refTag = '';
  if (refs && INTERACTIVE_ROLES.has(role.toLowerCase()) && isAxNodeInteractable(node)) {
    refTag = `@e${refIndex.value} `;
    refIndex.value++;
  }

  let line = `${indent}${refTag}[${role}]`;
  if (name !== '') line += ` ${name}`;
  if (!(value === '' || value == null)) line += ` = ${JSON.stringify(truncate(String(value)))}`;
  return line;
}

function orderedAxChildren(node, nodesById, childrenByParent) {
  const children = [];
  const seen = new Set();
  for (const childId of node.childIds || []) {
    const child = nodesById.get(childId);
    if (child && !seen.has(child.nodeId)) {
      seen.add(child.nodeId);
      children.push(child);
    }
  }
  for (const child of childrenByParent.get(node.nodeId) || []) {
    if (!seen.has(child.nodeId)) {
      seen.add(child.nodeId);
      children.push(child);
    }
  }
  return children;
}

// Build a fingerprint for each visible node: role + name + value + childCount
// Used for incremental diff to detect changes
function buildFingerprints(nodes, nodesById, childrenByParent, compact) {
  const fingerprints = new Map();
  for (const node of nodes) {
    if (!shouldShowAxNode(node, compact)) continue;
    const role = node.role?.value || '';
    const name = node.name?.value ?? '';
    const value = node.value?.value ?? '';
    const children = orderedAxChildren(node, nodesById, childrenByParent);
    const childIds = children.filter(c => shouldShowAxNode(c, compact)).map(c => c.nodeId).join(',');
    fingerprints.set(node.nodeId, `${role}|${name}|${value}|${childIds}`);
  }
  return fingerprints;
}

// refMap is populated when refs=true: { refNumber -> { backendNodeId, role, name } }
// The caller (daemon) stores this map for later ref resolution.
// previousFingerprints: Map from prior snapshot for incremental diff.
// maxDepth: limit tree depth (0 = unlimited). Nodes at the limit render as leaves.
// Returns { text, refMap, fingerprints } -- caller stores fingerprints for next diff.
export async function snapshotStr(cdp, sid, compact = true, refs = false, previousFingerprints = null, maxDepth = 0) {
  const { nodes } = await cdp.send('Accessibility.getFullAXTree', {}, sid);
  const nodesById = new Map(nodes.map(node => [node.nodeId, node]));
  const childrenByParent = new Map();
  for (const node of nodes) {
    if (!node.parentId) continue;
    if (!childrenByParent.has(node.parentId)) childrenByParent.set(node.parentId, []);
    childrenByParent.get(node.parentId).push(node);
  }

  const currentFingerprints = buildFingerprints(nodes, nodesById, childrenByParent, compact);
  const isDiff = previousFingerprints !== null && previousFingerprints.size > 0;

  const refIndex = { value: 1 };
  const refMap = new Map();
  const lines = [];
  const visited = new Set();

  // Track unchanged subtree roots for diff output
  let unchangedCount = 0;

  function isSubtreeUnchanged(node) {
    if (!previousFingerprints) return false;
    const nodeId = node.nodeId;
    const curr = currentFingerprints.get(nodeId);
    const prev = previousFingerprints.get(nodeId);
    if (!curr || !prev || curr !== prev) return false;
    // Node itself matches -- check all visible children recursively
    const children = orderedAxChildren(node, nodesById, childrenByParent);
    for (const child of children) {
      if (!shouldShowAxNode(child, compact)) continue;
      if (!isSubtreeUnchanged(child)) return false;
    }
    return true;
  }

  function visit(node, depth) {
    if (!node || visited.has(node.nodeId)) return;
    visited.add(node.nodeId);

    const show = shouldShowAxNode(node, compact);

    if (!show) {
      // Generic/none node: collapse by visiting children at SAME depth (no indentation increase)
      for (const child of orderedAxChildren(node, nodesById, childrenByParent)) {
        visit(child, depth);
      }
      return;
    }

    // Incremental diff: if this subtree is unchanged, collapse it
    if (isDiff && isSubtreeUnchanged(node)) {
      unchangedCount++;
      if (refs) {
        advanceRefsForSubtree(node);
      }
      return;
    }

    const role = node.role?.value || '';
    const currentRef = refIndex.value;

    lines.push(formatAxNode(node, depth, refIndex, refs));

    if (refs && refIndex.value > currentRef) {
      refMap.set(currentRef, {
        backendNodeId: node.backendDOMNodeId,
        nodeId: node.nodeId,
        role,
        name: node.name?.value ?? '',
      });
    }

    // Depth limiting: at the limit, render as leaf (no children)
    if (maxDepth > 0 && depth >= maxDepth) return;

    for (const child of orderedAxChildren(node, nodesById, childrenByParent)) {
      visit(child, depth + 1);
    }
  }

  // Advance ref counter for unchanged subtrees to keep ref numbers stable
  // Uses its own visited set because visit() already marked nodes before calling this
  const refAdvanced = new Set();
  function advanceRefsForSubtree(node) {
    if (!node || refAdvanced.has(node.nodeId)) return;
    refAdvanced.add(node.nodeId);
    if (shouldShowAxNode(node, compact)) {
      const role = node.role?.value || '';
      if (INTERACTIVE_ROLES.has(role.toLowerCase()) && isAxNodeInteractable(node)) {
        refMap.set(refIndex.value, {
          backendNodeId: node.backendDOMNodeId,
          nodeId: node.nodeId,
          role,
          name: node.name?.value ?? '',
        });
        refIndex.value++;
      }
    }
    for (const child of orderedAxChildren(node, nodesById, childrenByParent)) {
      advanceRefsForSubtree(child);
    }
  }

  const roots = nodes.filter(node => !node.parentId || !nodesById.has(node.parentId));
  for (const root of roots) visit(root, 0);
  // Second pass: catch disconnected nodes (skip when depth-limited to avoid false depth=0)
  if (!maxDepth) {
    for (const node of nodes) visit(node, 0);
  }

  // Add diff summary header when in incremental mode
  let text = lines.join('\n');
  if (isDiff && unchangedCount > 0) {
    const totalVisible = currentFingerprints.size;
    const changedCount = totalVisible - unchangedCount;
    text = `[incremental: ${changedCount} changed, ${unchangedCount} unchanged]\n${text}`;
  }

  return { text, refMap, fingerprints: currentFingerprints };
}
