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

const MAP_SNAPSHOT_SIZE = 480;
const MAP_ZOOM = 14;
const MARKER_COLOR = '#e11d48';

const renderMapSnapshot = (lat: number, lng: number): Promise<HTMLCanvasElement> =>
  new Promise((resolve, reject) => {
    const container = document.createElement('div');
    container.style.position = 'fixed';
    container.style.left = '-10000px';
    container.style.top = '0';
    container.style.width = `${MAP_SNAPSHOT_SIZE}px`;
    container.style.height = `${MAP_SNAPSHOT_SIZE}px`;
    document.body.append(container);

    const map = new maplibregl.Map({
      container,
      style: serverConfigManager.value.mapLightStyleUrl,
      center: [lng, lat],
      zoom: MAP_ZOOM,
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

const drawRoundedRect = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) => {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
};

const dateTimeLabel = (asset: AssetResponseDto) => {
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

const locationLabel = (asset: AssetResponseDto) =>
  [asset.exifInfo?.city, asset.exifInfo?.country].filter(Boolean).join(', ') || undefined;

/**
 * Renders a discreet "where/when this was taken" card into the bottom-right corner of the image,
 * for the printed-photo case where there's no interactive map to tap. Returns undefined (instead of
 * throwing) whenever this can't be done - no GPS, an image format the browser can't decode, etc. -
 * so callers can fall back to the plain, unmodified download.
 */
export const createLocationWatermarkedBlob = async (
  asset: AssetResponseDto,
  imageBlob: Blob,
): Promise<Blob | undefined> => {
  const lat = asset.exifInfo?.latitude;
  const lng = asset.exifInfo?.longitude;
  if (!lat || !lng) {
    return undefined;
  }

  try {
    const [bitmap, mapSnapshot] = await Promise.all([createImageBitmap(imageBlob), renderMapSnapshot(lat, lng)]);

    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return undefined;
    }
    ctx.drawImage(bitmap, 0, 0);

    const shortSide = Math.min(bitmap.width, bitmap.height);
    const mapSize = Math.min(380, Math.max(160, Math.round(shortSide * 0.18)));
    const margin = Math.round(shortSide * 0.03);
    const pad = Math.round(mapSize * 0.09);
    const radius = Math.round(mapSize * 0.1);

    const lines = [locationLabel(asset), dateTimeLabel(asset)].filter((line): line is string => !!line);
    const lineHeight = Math.round(mapSize * 0.16);
    const textBlockHeight = lines.length * lineHeight;

    const cardWidth = mapSize + pad * 2;
    const cardHeight = mapSize + pad * 2 + textBlockHeight;
    const cardX = canvas.width - margin - cardWidth;
    const cardY = canvas.height - margin - cardHeight;

    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = Math.round(shortSide * 0.006);
    drawRoundedRect(ctx, cardX, cardY, cardWidth, cardHeight, radius);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.fill();
    ctx.restore();

    ctx.save();
    drawRoundedRect(ctx, cardX + pad, cardY + pad, mapSize, mapSize, radius * 0.7);
    ctx.clip();
    ctx.drawImage(mapSnapshot, cardX + pad, cardY + pad, mapSize, mapSize);
    ctx.restore();

    const centerX = cardX + pad + mapSize / 2;
    const centerY = cardY + pad + mapSize / 2;
    const dotRadius = Math.max(4, mapSize * 0.045);
    ctx.beginPath();
    ctx.arc(centerX, centerY, dotRadius, 0, Math.PI * 2);
    ctx.fillStyle = MARKER_COLOR;
    ctx.fill();
    ctx.lineWidth = dotRadius * 0.4;
    ctx.strokeStyle = 'white';
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    let textY = cardY + pad + mapSize + Math.round(pad * 0.4);
    for (const [index, line] of lines.entries()) {
      ctx.font = `${index === 0 ? 600 : 400} ${Math.round(mapSize * 0.13)}px sans-serif`;
      ctx.fillStyle = index === 0 ? '#111827' : '#4b5563';
      ctx.fillText(line, cardX + cardWidth / 2, textY, cardWidth - pad);
      textY += lineHeight;
    }

    return await new Promise<Blob | undefined>((resolve) =>
      canvas.toBlob((blob) => resolve(blob ?? undefined), 'image/jpeg', 0.92),
    );
  } catch (error) {
    console.error('Failed to render location watermark for download', error);
    return undefined;
  }
};
