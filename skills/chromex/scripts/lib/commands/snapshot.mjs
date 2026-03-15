// Accessibility tree snapshot with optional interactive refs (@e1, @e2...)

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
  'menuitem', 'tab', 'switch', 'searchbox', 'slider', 'spinbutton',
  'option', 'menuitemcheckbox', 'menuitemradio', 'treeitem',
]);

function shouldShowAxNode(node, compact = false) {
  const role = node.role?.value || '';
  const name = node.name?.value ?? '';
  const value = node.value?.value;
  if (compact && role === 'InlineTextBox') return false;
  return role !== 'none' && role !== 'generic' && !(name === '' && (value === '' || value == null));
}

function formatAxNode(node, depth, refIndex, refs) {
  const role = node.role?.value || '';
  const name = node.name?.value ?? '';
  const value = node.value?.value;
  const indent = '  '.repeat(Math.min(depth, 10));

  let refTag = '';
  if (refs && INTERACTIVE_ROLES.has(role.toLowerCase())) {
    refTag = `@e${refIndex.value} `;
    refIndex.value++;
  }

  let line = `${indent}${refTag}[${role}]`;
  if (name !== '') line += ` ${name}`;
  if (!(value === '' || value == null)) line += ` = ${JSON.stringify(value)}`;
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

// refMap is populated when refs=true: { refNumber -> { backendNodeId, role, name } }
// The caller (daemon) stores this map for later ref resolution.
export async function snapshotStr(cdp, sid, compact = true, refs = false) {
  const { nodes } = await cdp.send('Accessibility.getFullAXTree', {}, sid);
  const nodesById = new Map(nodes.map(node => [node.nodeId, node]));
  const childrenByParent = new Map();
  for (const node of nodes) {
    if (!node.parentId) continue;
    if (!childrenByParent.has(node.parentId)) childrenByParent.set(node.parentId, []);
    childrenByParent.get(node.parentId).push(node);
  }

  const refIndex = { value: 1 };
  const refMap = new Map();
  const lines = [];
  const visited = new Set();

  function visit(node, depth) {
    if (!node || visited.has(node.nodeId)) return;
    visited.add(node.nodeId);
    if (shouldShowAxNode(node, compact)) {
      const role = node.role?.value || '';
      const currentRef = refIndex.value;

      lines.push(formatAxNode(node, depth, refIndex, refs));

      // If ref was assigned (refIndex advanced), record the mapping
      if (refs && refIndex.value > currentRef) {
        refMap.set(currentRef, {
          backendNodeId: node.backendDOMNodeId,
          nodeId: node.nodeId,
          role,
          name: node.name?.value ?? '',
        });
      }
    }
    for (const child of orderedAxChildren(node, nodesById, childrenByParent)) {
      visit(child, depth + 1);
    }
  }

  const roots = nodes.filter(node => !node.parentId || !nodesById.has(node.parentId));
  for (const root of roots) visit(root, 0);
  for (const node of nodes) visit(node, 0);

  return { text: lines.join('\n'), refMap };
}
