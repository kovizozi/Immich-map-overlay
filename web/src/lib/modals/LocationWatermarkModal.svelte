<script lang="ts">
  import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
  import { downloadBlob, getAssetMediaUrl } from '$lib/utils';
  import {
    createLocationWatermarkedBlob,
    dateTimeLabel,
    DEFAULT_WATERMARK_ZOOM,
    locationLabel,
    WATERMARK_MAP_ASPECT,
  } from '$lib/utils/asset-download-watermark';
  import { handleError } from '$lib/utils/handle-error';
  import { AssetMediaSize, type AssetResponseDto } from '@immich/sdk';
  import { FormModal, Icon } from '@immich/ui';
  import { mdiMapMarker } from '@mdi/js';
  import type { LngLatLike, Map as MaplibreMap } from 'maplibre-gl';
  import { MapLibre, Marker } from 'svelte-maplibre';
  import { t } from 'svelte-i18n';

  interface Props {
    asset: AssetResponseDto;
    onClose: (downloaded: boolean) => void;
  }

  let { asset, onClose }: Props = $props();

  const lat = asset.exifInfo!.latitude!;
  const lng = asset.exifInfo!.longitude!;
  const photoAspect = (asset.width ?? 4) / (asset.height ?? 3);
  const caption = [locationLabel(asset), dateTimeLabel(asset)].filter(Boolean).join('   ·   ');

  // Card footprint as a percentage of the photo, kept in sync with the pixel math in
  // asset-download-watermark.ts (~40% of the shorter side there vs. of the width here - close enough
  // for a drag preview, since the user can see and correct the exact result before confirming).
  const CARD_WIDTH_PERCENT = 34;
  const CARD_MAP_HEIGHT_PERCENT = (CARD_WIDTH_PERCENT * photoAspect) / WATERMARK_MAP_ASPECT;
  const CAPTION_HEIGHT_PERCENT = 6;
  const CARD_HEIGHT_PERCENT = CARD_MAP_HEIGHT_PERCENT + CAPTION_HEIGHT_PERCENT;

  let mapInstance: MaplibreMap | undefined = $state();
  let center = $state<LngLatLike>([lng, lat]);
  let zoom = $state(DEFAULT_WATERMARK_ZOOM);
  let previewSnapshot = $state<string>();

  let photoEl: HTMLDivElement | undefined = $state();
  let cardPos = $state({
    xPercent: 100 - CARD_WIDTH_PERCENT - 4,
    yPercent: 100 - CARD_HEIGHT_PERCENT - 4,
  });
  let dragOrigin: { x: number; y: number; xPercent: number; yPercent: number } | undefined;
  let busy = $state(false);

  const styleUrl = serverConfigManager.value.mapLightStyleUrl;

  const onMapIdle = () => {
    previewSnapshot = mapInstance?.getCanvas().toDataURL();
  };

  const onCardPointerDown = (event: PointerEvent) => {
    dragOrigin = { x: event.clientX, y: event.clientY, ...cardPos };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const onCardPointerMove = (event: PointerEvent) => {
    if (!dragOrigin || !photoEl) {
      return;
    }

    const rect = photoEl.getBoundingClientRect();
    const dxPercent = ((event.clientX - dragOrigin.x) / rect.width) * 100;
    const dyPercent = ((event.clientY - dragOrigin.y) / rect.height) * 100;

    cardPos = {
      xPercent: Math.min(Math.max(dragOrigin.xPercent + dxPercent, 0), 100 - CARD_WIDTH_PERCENT),
      yPercent: Math.min(Math.max(dragOrigin.yPercent + dyPercent, 0), 100 - CARD_HEIGHT_PERCENT),
    };
  };

  const onCardPointerUp = () => {
    dragOrigin = undefined;
  };

  const onSubmit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!mapInstance) {
      return;
    }

    busy = true;
    try {
      const mapCenter = mapInstance.getCenter();
      const mapZoom = mapInstance.getZoom();
      const mediaUrl = getAssetMediaUrl({
        id: asset.id,
        size: AssetMediaSize.Original,
        edited: true,
        cacheKey: asset.thumbhash,
      });

      const response = await fetch(mediaUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch original (${response.status})`);
      }

      const blob = await createLocationWatermarkedBlob(asset, await response.blob(), {
        mapCenter: { lat: mapCenter.lat, lng: mapCenter.lng },
        mapZoom,
        cardPosition: cardPos,
      });
      if (!blob) {
        throw new Error('Failed to render watermark');
      }

      downloadBlob(blob, asset.originalFileName);
      onClose(true);
    } catch (error) {
      handleError(error, $t('errors.error_downloading', { values: { filename: asset.originalFileName } }));
    } finally {
      busy = false;
    }
  };
</script>

<FormModal
  title={$t('location_watermark_title')}
  icon={mdiMapMarker}
  onClose={() => onClose(false)}
  {onSubmit}
  submitText={$t('download')}
  disabled={busy}
  size="large"
>
  <div class="flex flex-col gap-3">
    <p class="text-sm text-gray-500">{$t('location_watermark_hint')}</p>

    <div class="w-full overflow-hidden rounded-lg border border-gray-300" style:aspect-ratio={WATERMARK_MAP_ASPECT}>
      <MapLibre
        style={styleUrl}
        class="size-full"
        bind:map={mapInstance}
        bind:center
        bind:zoom
        onidle={onMapIdle}
        attributionControl={false}
      >
        <Marker lngLat={[lng, lat]}>
          <Icon icon={mdiMapMarker} size="28px" class="translate-y-[calc(4px-50%)] text-primary" />
        </Marker>
      </MapLibre>
    </div>

    <div
      bind:this={photoEl}
      class="relative w-full overflow-hidden rounded-lg bg-black"
      style:aspect-ratio={photoAspect}
    >
      <img
        src={getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Preview, cacheKey: asset.thumbhash })}
        alt=""
        class="size-full object-cover"
      />

      <button
        type="button"
        class="watermark-card absolute cursor-move touch-none border-none bg-transparent p-0 text-left"
        style:left="{cardPos.xPercent}%"
        style:top="{cardPos.yPercent}%"
        style:width="{CARD_WIDTH_PERCENT}%"
        aria-label={$t('location_watermark_title')}
        onpointerdown={onCardPointerDown}
        onpointermove={onCardPointerMove}
        onpointerup={onCardPointerUp}
        onpointercancel={onCardPointerUp}
      >
        <div
          class="watermark-crop"
          style:aspect-ratio={WATERMARK_MAP_ASPECT}
          style:background-image={previewSnapshot ? `url(${previewSnapshot})` : 'none'}
        >
          <span class="watermark-pin"></span>
        </div>
        {#if caption}
          <p class="watermark-caption">{caption}</p>
        {/if}
      </button>
    </div>
  </div>
</FormModal>

<style>
  .watermark-crop {
    position: relative;
    width: 100%;
    background-color: rgb(147 166 130);
    background-size: cover;
    background-position: center;
    -webkit-mask-image:
      linear-gradient(to right, transparent, white 16%, white 84%, transparent),
      linear-gradient(to bottom, transparent, white 20%, white 80%, transparent);
    -webkit-mask-composite: source-in, source-over;
    mask-image:
      linear-gradient(to right, transparent, white 16%, white 84%, transparent),
      linear-gradient(to bottom, transparent, white 20%, white 80%, transparent);
    mask-composite: intersect;
  }

  .watermark-pin {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 14%;
    aspect-ratio: 1;
    border-radius: 50%;
    background: #e11d48;
    box-shadow: 0 0 0 1.5px rgba(255, 255, 255, 0.9);
  }

  .watermark-caption {
    margin: 6px 0 0;
    color: #fff;
    font-size: 13px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    text-shadow: 0 1px 4px rgba(0, 0, 0, 0.8);
  }
</style>
