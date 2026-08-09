import { persisted } from 'svelte-persisted-store';

export interface AssetMapOverlaySettings {
  visible: boolean;
  /** Distance from the right edge of the viewport, in pixels. */
  right: number;
  /** Distance from the bottom edge of the viewport, in pixels. */
  bottom: number;
  /** Map body width in pixels. Unset until the user resizes it, so the responsive default applies. */
  width?: number;
  /** Map body height in pixels. Unset until the user resizes it, so the responsive default applies. */
  height?: number;
}

/**
 * The default anchor keeps the overlay in the bottom right corner without covering the
 * controls that already live there (the OCR button and the shared album activity status).
 */
const defaultAssetMapOverlaySettings: AssetMapOverlaySettings = {
  visible: true,
  right: 24,
  bottom: 96,
};

export const assetMapOverlaySettings = persisted<AssetMapOverlaySettings>(
  'asset-map-overlay',
  defaultAssetMapOverlaySettings,
  {
    serializer: {
      parse: (text) => ({ ...defaultAssetMapOverlaySettings, ...JSON.parse(text ?? null) }),
      stringify: JSON.stringify,
    },
  },
);
