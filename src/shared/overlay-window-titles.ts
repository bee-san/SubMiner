export const VISIBLE_OVERLAY_WINDOW_TITLE = 'SubMiner Visible Overlay';
export const MODAL_OVERLAY_WINDOW_TITLE = 'SubMiner Modal Overlay';

export function getOverlayWindowTitle(kind: 'visible' | 'modal'): string {
  return kind === 'visible' ? VISIBLE_OVERLAY_WINDOW_TITLE : MODAL_OVERLAY_WINDOW_TITLE;
}
