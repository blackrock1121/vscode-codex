/** 同步重绘后按文本位置恢复选区；选中文字或其前缀变化时不选中别的内容。 */
export function preserveTextSelection(root: HTMLElement): () => void {
  const selection = window.getSelection();
  const anchor = selection?.anchorNode, focus = selection?.focusNode;
  if (!selection || selection.isCollapsed || !anchor || !focus || !root.contains(anchor) || !root.contains(focus)) return () => {};
  const offset = (node: Node, end: number) => {
    const range = document.createRange();
    range.selectNodeContents(root); range.setEnd(node, end);
    return range.toString().length;
  };
  const start = offset(anchor, selection.anchorOffset), end = offset(focus, selection.focusOffset);
  const prefix = root.textContent!.slice(0, Math.max(start, end));
  const active = document.activeElement as HTMLElement | null;
  return () => {
    if (!root.isConnected || !root.textContent?.startsWith(prefix)) return;
    if (active?.isConnected && root.contains(active) && document.activeElement === document.body) active.focus({ preventScroll: true });
    const point = (position: number, preferNext: boolean): [Node, number] => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const length = node.textContent?.length ?? 0;
        // 起点落在两段交界时属于下一段，不能恢复到上一段末尾而多复制换行。
        if (position < length || position === length && !preferNext) return [node, position];
        position -= length;
      }
      return [root, root.childNodes.length];
    };
    const [anchorNode, anchorOffset] = point(start, start < end), [focusNode, focusOffset] = point(end, end < start);
    selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
  };
}
