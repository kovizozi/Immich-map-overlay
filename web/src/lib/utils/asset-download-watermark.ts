import { type AssetResponseDto } from '@immich/sdk';
import mapboxRtlUrl from '@mapbox/mapbox-gl-rtl-text?url';
import maplibregl, { addProtocol, setRTLTextPlugin } from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import { get } from 'svelte/store';
import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
import { locale } from '$lib/stores/preferences.store';
import { fromISODateTime, fromISODateTimeUTC } from '$lib/utils/timeline-util';

// Mirrors the one-time protocol registration in Map.svelte / AssetMapOverlayTrack.svelte - needed again
// here since this module renders its own throwaway MapLibre instance outside of either component.
const protocol = new Protocol();
void addProtocol('pmtiles', protocol.tile);
void setRTLTextPlugin(mapboxRtlUrl, true);

// The card's map crop is a wide rectangle (not a square), matching the aspect ratio previewed in the
// edit modal so what the user frames there is exactly what ends up in the final download.
export const WATERMARK_MAP_ASPECT = 2;
export const DEFAULT_WATERMARK_ZOOM = 12;

const MARKER_COLOR = '#e11d48';

export interface WatermarkPlacement {
  mapCenter: { lat: number; lng: number };
  mapZoom: number;
  /** Top-left corner of the map crop, as a percentage of the photo's width/height. */
  cardPosition: { xPercent: number; yPercent: number };
  /** Width of the map crop, as a percentage of the photo's width. */
  widthPercent: number;
}

const renderMapSnapshot = (
  center: { lat: number; lng: number },
  zoom: number,
  width: number,
  height: number,
): Promise<HTMLCanvasElement> =>
  new Promise((resolve, reject) => {
    const container = document.createElement('div');
    container.style.position = 'fixed';
    container.style.left = '-10000px';
    container.style.top = '0';
    container.style.width = `${width}px`;
    container.style.height = `${height}px`;
    document.body.append(container);

    const map = new maplibregl.Map({
      container,
      style: serverConfigManager.value.mapLightStyleUrl,
      center: [center.lng, center.lat],
      zoom,
      interactive: false,
      attributionControl: false,
      // Without this the WebGL buffer can be cleared before we get a chance to read it into a 2D canvas.
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });

    const cleanup = () => {
      map.remove();
      container.remove();
    };

    map.once('idle', () => {
      const snapshot = document.createElement('canvas');
      snapshot.width = map.getCanvas().width;
      snapshot.height = map.getCanvas().height;
      snapshot.getContext('2d')?.drawImage(map.getCanvas(), 0, 0);
      cleanup();
      resolve(snapshot);
    });

    map.once('error', (event) => {
      cleanup();
      reject(event.error ?? new Error('Failed to render map snapshot'));
    });
  });

export const dateTimeLabel = (asset: AssetResponseDto) => {
  const timeZone = asset.exifInfo?.timeZone ?? undefined;
  const dateTime =
    timeZone && asset.exifInfo?.dateTimeOriginal
      ? fromISODateTime(asset.exifInfo.dateTimeOriginal, timeZone)
      : fromISODateTimeUTC(asset.localDateTime);
  return dateTime.isValid
    ? dateTime.toLocaleString(
        { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
        { locale: get(locale) },
      )
    : undefined;
};

export const locationLabel = (asset: AssetResponseDto) =>
  [asset.exifInfo?.city, asset.exifInfo?.country].filter(Boolean).join(', ') || undefined;

/**
 * Feathers a map snapshot into a borderless rectangle - no crop line, no rounded corners - by masking
 * with two intersecting linear-gradient fades (one per axis), mirroring `mask-composite: intersect`
 * since canvas has no direct equivalent.
 */
const featherCard = (mapSnapshot: HTMLCanvasElement, width: number, height: number): HTMLCanvasElement => {
  const card = document.createElement('canvas');
  card.width = width;
  card.height = height;
  const ctx = card.getContext('2d')!;
  ctx.drawImage(mapSnapshot, 0, 0, width, height);

  ctx.globalCompositeOperation = 'destination-in';

  const featherX = ctx.createLinearGradient(0, 0, width, 0);
  featherX.addColorStop(0, 'rgba(0, 0, 0, 0)');
  featherX.addColorStop(0.05, 'rgba(0, 0, 0, 1)');
  featherX.addColorStop(0.95, 'rgba(0, 0, 0, 1)');
  featherX.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = featherX;
  ctx.fillRect(0, 0, width, height);

  const featherY = ctx.createLinearGradient(0, 0, 0, height);
  featherY.addColorStop(0, 'rgba(0, 0, 0, 0)');
  featherY.addColorStop(0.06, 'rgba(0, 0, 0, 1)');
  featherY.addColorStop(0.94, 'rgba(0, 0, 0, 1)');
  featherY.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = featherY;
  ctx.fillRect(0, 0, width, height);

  ctx.globalCompositeOperation = 'source-over';
  return card;
};

/**
 * Renders a discreet "where/when this was taken" mark into the image, for the printed-photo case
 * where there's no interactive map to tap: a feathered (borderless) map crop with a pin, plus a
 * single-line location/date caption underneath. Returns undefined (instead of throwing) whenever this
 * can't be done - the browser can't decode the source image (e.g. RAW/HEIC), etc. - so callers can
 * fall back to the plain, unmodified download.
 */
export const createLocationWatermarkedBlob = async (
  asset: AssetResponseDto,
  imageBlob: Blob,
  placement: WatermarkPlacement,
): Promise<Blob | undefined> => {
  try {
    const bitmap = await createImageBitmap(imageBlob);

    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return undefined;
    }
    ctx.drawImage(bitmap, 0, 0);

    const mapWidth = Math.round((placement.widthPercent / 100) * canvas.width);
    const mapHeight = Math.round(mapWidth / WATERMARK_MAP_ASPECT);

    const mapSnapshot = await renderMapSnapshot(placement.mapCenter, placement.mapZoom, mapWidth, mapHeight);
    const card = featherCard(mapSnapshot, mapWidth, mapHeight);

    const cardX = (placement.cardPosition.xPercent / 100) * canvas.width;
    const cardY = (placement.cardPosition.yPercent / 100) * canvas.height;

    ctx.drawImage(card, cardX, cardY);

    const dotRadius = Math.max(3, mapHeight * 0.035);
    ctx.beginPath();
    ctx.arc(cardX + mapWidth / 2, cardY + mapHeight / 2, dotRadius, 0, Math.PI * 2);
    ctx.fillStyle = MARKER_COLOR;
    ctx.fill();
    ctx.lineWidth = dotRadius * 0.35;
    ctx.strokeStyle = 'white';
    ctx.stroke();

    const label = [locationLabel(asset), dateTimeLabel(asset)].filter(Boolean).join('   ·   ');
    if (label) {
      const fontSize = Math.round(mapHeight * 0.2);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.font = `600 ${fontSize}px sans-serif`;
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
      ctx.shadowBlur = fontSize * 0.35;
      ctx.fillText(label, cardX, cardY + mapHeight + fontSize * 0.3);
    }

    return await new Promise<Blob | undefined>((resolve) =>
      canvas.toBlob((blob) => resolve(blob ?? undefined), 'image/jpeg', 0.92),
    );
  } catch (error) {
    console.error('Failed to render location watermark for download', error);
    return undefined;
  }
};
