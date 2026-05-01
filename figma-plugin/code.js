// Design → Dev Handover — Figma Plugin
// Runs in Figma's privileged sandbox. Communicates with ui.html via postMessage.

figma.showUI(__html__, {
  width:  380,
  height: 620,
  title:  'Design → Dev Handover'
});

// Prefix that marks a frame as an explicit section, regardless of nesting depth.
const SECTION_PREFIX = '//';

// Node types that can contain child nodes we care about.
// SECTION is Figma's canvas-organiser type (the coloured grouping boxes).
// INSTANCE is a placed component instance — may contain renamed // frames.
const CONTAINER_TYPES = new Set(['FRAME', 'COMPONENT', 'GROUP', 'SECTION', 'INSTANCE']);

// Recursively search all descendants of `node` for frames/components/groups
// whose name starts with SECTION_PREFIX. Returns them as section objects,
// with the prefix stripped from the display name.
function findPrefixedSections(node, fileKey, pageName) {
  const results = [];
  for (const child of (node.children || [])) {
    if (child.visible === false) continue;
    if (!CONTAINER_TYPES.has(child.type)) continue;

    if (child.name.startsWith(SECTION_PREFIX)) {
      results.push({
        id:        child.id,
        name:      child.name.slice(SECTION_PREFIX.length).trim(),
        figmaLink: fileKey
          ? `https://www.figma.com/design/${fileKey}/${encodeURIComponent(pageName)}?node-id=${child.id.replace(':', '-')}`
          : ''
      });
      // Treat // nodes as atomic — don't recurse into them. This prevents
      // internal sub-frames inside an auto-layout // section from polluting
      // the flat sections list, and is consistent with COMPONENT behaviour.
      continue;
    }
    // Don't recurse into component instances or component definitions —
    // they are atomic sections; their internal frames are not user-facing
    // page sections and would pollute results if picked up.
    if (child.type === 'INSTANCE' || child.type === 'COMPONENT') continue;
    // Recurse into frames/groups/Figma Sections — they may wrap // frames
    // without having a // prefix themselves.
    results.push(...findPrefixedSections(child, fileKey, pageName));
  }
  return results;
}

function buildPageData() {
  const page     = figma.currentPage;
  const fileKey  = figma.fileKey || '';
  const pageName = page.name;

  const toSection = node => ({
    id:        node.id,
    name:      node.name.startsWith(SECTION_PREFIX) ? node.name.slice(SECTION_PREFIX.length).trim() : node.name,
    figmaLink: fileKey
      ? `https://www.figma.com/design/${fileKey}/${encodeURIComponent(pageName)}?node-id=${node.id.replace(':', '-')}`
      : ''
  });

  const rawTopFrames = page.children
    // Include both FRAME and SECTION types — Figma Sections are top-level
    // canvas organisers that may contain the user's // frames.
    .filter(n => (n.type === 'FRAME' || n.type === 'SECTION') && n.visible !== false)
    .map(n => {
      // If the top-level frame itself carries the // prefix, treat it directly
      // as a section (don't look inside it for sub-sections).
      if (n.name.startsWith(SECTION_PREFIX)) {
        return { id: n.id, name: n.name, childCount: 0, sections: [toSection(n)], _canvasSection: true };
      }

      // 1. Look for explicitly prefixed sections anywhere in the subtree
      const prefixed = findPrefixedSections(n, fileKey, pageName);
      if (prefixed.length > 0) {
        return { id: n.id, name: n.name, childCount: prefixed.length, sections: prefixed };
      }

      // 2. Fallback: direct children (original behaviour, no prefix used)
      const childFrames = (n.children || [])
        .filter(c => CONTAINER_TYPES.has(c.type) && c.visible !== false);

      return {
        id:         n.id,
        name:       n.name,
        childCount: childFrames.length,
        sections:   childFrames.length > 0 ? childFrames.map(toSection) : [toSection(n)]
      };
    });

  // When multiple top-level frames are // sections (flat canvas layout),
  // merge them into one virtual container so all sections are visible together.
  const canvasSections = rawTopFrames.filter(f => f._canvasSection);
  let topFrames;
  if (canvasSections.length > 1) {
    const merged = {
      id:         '__canvas__',
      name:       pageName,
      childCount: canvasSections.length,
      sections:   canvasSections.map(f => f.sections[0])
    };
    const rest = rawTopFrames.filter(f => !f._canvasSection);
    topFrames = [merged, ...rest];
  } else {
    topFrames = rawTopFrames.map(f => {
      var out = Object.assign({}, f);
      delete out._canvasSection;
      return out;
    });
  }

  return {
    pageName,
    fileKey,
    rootId:       figma.root.id,
    figmaFileUrl: fileKey
      ? `https://www.figma.com/design/${fileKey}/${encodeURIComponent(pageName)}`
      : '',
    topFrames
  };
}

// Send initial page data to UI
figma.ui.postMessage({ type: 'page-data', data: buildPageData() });

// Handle messages from UI
figma.ui.onmessage = async msg => {
  switch (msg.type) {

    case 'open-url':
      figma.openExternal(msg.url);
      break;

    case 'close':
      figma.closePlugin();
      break;

    case 'refresh':
      figma.ui.postMessage({ type: 'page-data', data: buildPageData() });
      break;

    case 'get-storage': {
      const value = await figma.clientStorage.getAsync(msg.key);
      figma.ui.postMessage({ type: 'storage-value', key: msg.key, value });
      break;
    }

    case 'set-storage':
      await figma.clientStorage.setAsync(msg.key, msg.value);
      break;

    case 'del-storage':
      await figma.clientStorage.deleteAsync(msg.key);
      break;
  }
};
