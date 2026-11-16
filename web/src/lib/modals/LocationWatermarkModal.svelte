<script lang="ts">
  import { createPreloadedQuery } from '#lib/queries/client.ts';
  import { getPublicConfigQuery } from '#lib/queries/config-public.query.ts';
  import { downloadBlob, getAssetMediaUrl } from '#lib/utils.ts';
  import {
    DEFAULT_WATERMARK_MAP_ASPECT,
    DEFAULT_WATERMARK_ZOOM,
    createLocationWatermarkedBlob,
    dateTimeLabel,
    locationLabel,
  } from '#lib/utils/asset-download-watermark.ts';
  import { handleError } from '#lib/utils/handle-error.ts';
  import { AssetMediaSize, type AssetResponseDto } from '@immich/sdk';
  import { FormModal, Icon, Switch } from '@immich/ui';
  import { mdiMapMarker, mdiResizeBottomRight } from '@mdi/js';
  import type { LngLatLike, Map as MaplibreMap } from 'maplibre-gl';
  import { t } from 'svelte-i18n';
  import { MapLibre, Marker } from 'svelte-maplibre';

  interface Props {
    asset: AssetResponseDto;
    onClose: (downloaded: boolean) => void;
  }

  let { asset, onClose }: Props = $props();

  const lat = asset.exifInfo!.latitude!;
  const lng = asset.exifInfo!.longitude!;
  const photoAspect = (asset.width ?? 4) / (asset.height ?? 3);
  const captionLines = [
    { text: locationLabel(asset), muted: false },
    { text: dateTimeLabel(asset), muted: true },
  ].filter((line): line is { text: string; muted: boolean } => !!line.text);

  const MIN_CARD_WIDTH_PERCENT = 14;
  const MAX_CARD_WIDTH_PERCENT = 55;
  const MIN_MAP_ASPECT = 1;
  const MAX_MAP_ASPECT = 3.2;
  const MIN_CAPTION_SCALE = 0.6;
  const MAX_CAPTION_SCALE = 1.8;
  // Matches BASE_CAPTION_LINE_FACTOR in asset-download-watermark.ts, expressed relative to the card's
  // own width (not the map height) so it works as a CSS container-query font-size.
  const CAPTION_LINE_CQW = (16 * 1.25) / DEFAULT_WATERMARK_MAP_ASPECT;

  let mapInstance: MaplibreMap | undefined = $state();
  let center = $state<LngLatLike>([lng, lat]);
  let zoom = $state(DEFAULT_WATERMARK_ZOOM);
  let previewSnapshot = $state<string>();
  // Where the real GPS point currently projects to within the interactive map, as a 0-100% offset -
  // tracked live so the pin follows it instead of sitting frozen at the crop's center once you pan.
  let pinOffset = $state({ xPercent: 50, yPercent: 50 });

  let photoEl: HTMLDivElement | undefined = $state();
  let cardWidthPercent = $state(26);
  let mapAspect = $state(DEFAULT_WATERMARK_MAP_ASPECT);
  let captionScale = $state(1);
  let captionAbove = $state(false);

  const mapHeightPercent = $derived((cardWidthPercent * photoAspect) / mapAspect);
  const captionBlockHeightPercent = $derived(
    captionLines.length === 0
      ? 0
      : mapHeightPercent * 0.06 + mapHeightPercent * 0.16 * 1.25 * captionScale * captionLines.length,
  );
  const cardHeightPercent = $derived(mapHeightPercent + captionBlockHeightPercent);

  let cardPos = $state({
    xPercent: 100 - cardWidthPercent - 4,
    yPercent: 100 - cardHeightPercent - 4,
  });
  let dragOrigin: { x: number; y: number; xPercent: number; yPercent: number } | undefined;
  let resizeOrigin: { x: number; widthPercent: number } | undefined;
  let busy = $state(false);

  const publicConfigQuery = createPreloadedQuery(getPublicConfigQuery);
  const styleUrl = $derived(publicConfigQuery.data.map.lightStyle);

  const onMapIdle = () => {
    if (!mapInstance) {
      return;
    }

    previewSnapshot = mapInstance.getCanvas().toDataURL();

    const point = mapInstance.project([lng, lat]);
    const canvas = mapInstance.getCanvas();
    pinOffset = {
      xPercent: Math.min(100, Math.max(0, (point.x / canvas.clientWidth) * 100)),
      yPercent: Math.min(100, Math.max(0, (point.y / canvas.clientHeight) * 100)),
    };
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
      xPercent: Math.min(Math.max(dragOrigin.xPercent + dxPercent, 0), 100 - cardWidthPercent),
      yPercent: Math.min(Math.max(dragOrigin.yPercent + dyPercent, 0), 100 - cardHeightPercent),
    };
  };

  const onCardPointerUp = () => {
    dragOrigin = undefined;
  };

  const onResizePointerDown = (event: PointerEvent) => {
    resizeOrigin = { x: event.clientX, widthPercent: cardWidthPercent };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const onResizePointerMove = (event: PointerEvent) => {
    if (!resizeOrigin || !photoEl) {
      return;
    }

    const rect = photoEl.getBoundingClientRect();
    const dxPercent = ((event.clientX - resizeOrigin.x) / rect.width) * 100;
    cardWidthPercent = Math.min(
      MAX_CARD_WIDTH_PERCENT,
      Math.max(MIN_CARD_WIDTH_PERCENT, resizeOrigin.widthPercent + dxPercent),
    );

    // Keep the (possibly now bigger) card from spilling off the photo.
    cardPos = {
      xPercent: Math.min(cardPos.xPercent, 100 - cardWidthPercent),
      yPercent: Math.min(cardPos.yPercent, 100 - cardHeightPercent),
    };
  };

  const onResizePointerUp = () => {
    resizeOrigin = undefined;
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
        widthPercent: cardWidthPercent,
        mapAspect,
        captionScale,
        captionPosition: captionAbove ? 'above' : 'below',
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

{#snippet captionBlock()}
  {#each captionLines as line (line.text)}
    <p
      class="watermark-caption"
      class:opacity-80={line.muted}
      style:font-size="calc({CAPTION_LINE_CQW} * {captionScale} * 1cqw)"
    >
      {line.text}
    </p>
  {/each}
{/snippet}

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

    <div class="w-full overflow-hidden rounded-lg border border-gray-300" style:aspect-ratio={mapAspect}>
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

      <div
        class="watermark-card absolute"
        style:left="{cardPos.xPercent}%"
        style:top="{cardPos.yPercent}%"
        style:width="{cardWidthPercent}%"
      >
        <button
          type="button"
          class="block w-full cursor-move touch-none border-none bg-transparent p-0 text-left"
          aria-label={$t('location_watermark_title')}
          onpointerdown={onCardPointerDown}
          onpointermove={onCardPointerMove}
          onpointerup={onCardPointerUp}
          onpointercancel={onCardPointerUp}
        >
          {#if captionAbove}
            {@render captionBlock()}
          {/if}

          <div
            class="watermark-crop"
            style:aspect-ratio={mapAspect}
            style:background-image={previewSnapshot ? `url(${previewSnapshot})` : 'none'}
          >
            <span class="watermark-pin" style:left="{pinOffset.xPercent}%" style:top="{pinOffset.yPercent}%"></span>
          </div>

          {#if !captionAbove}
            {@render captionBlock()}
          {/if}
        </button>

        <button
          type="button"
          class="watermark-resize absolute flex cursor-nwse-resize touch-none items-center justify-center border-none bg-transparent p-0"
          aria-label={$t('resize')}
          onpointerdown={onResizePointerDown}
          onpointermove={onResizePointerMove}
          onpointerup={onResizePointerUp}
          onpointercancel={onResizePointerUp}
        >
          <Icon icon={mdiResizeBottomRight} size="14" class="text-white drop-shadow" />
        </button>
      </div>
    </div>

    <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <label class="flex flex-col gap-1 text-sm">
        <span class="text-gray-500">{$t('location_watermark_font_size')}</span>
        <input type="range" min={MIN_CAPTION_SCALE} max={MAX_CAPTION_SCALE} step="0.1" bind:value={captionScale} />
      </label>

      <label class="flex flex-col gap-1 text-sm">
        <span class="text-gray-500">{$t('location_watermark_map_ratio')}</span>
        <input type="range" min={MIN_MAP_ASPECT} max={MAX_MAP_ASPECT} step="0.1" bind:value={mapAspect} />
      </label>

      <div class="flex items-center justify-between gap-2 text-sm sm:justify-start">
        <span class="text-gray-500">{$t('location_watermark_caption_above')}</span>
        <Switch bind:checked={captionAbove} />
      </div>
    </div>
  </div>
</FormModal>

<style>
  .watermark-card {
    container-type: inline-size;
  }

  .watermark-crop {
    position: relative;
    width: 100%;
    background-color: rgb(147 166 130);
    background-size: cover;
    background-position: center;
    -webkit-mask-image:
      linear-gradient(to right, transparent, white 3%, white 97%, transparent),
      linear-gradient(to bottom, transparent, white 4%, white 96%, transparent);
    -webkit-mask-composite: source-in, source-over;
    mask-image:
      linear-gradient(to right, transparent, white 3%, white 97%, transparent),
      linear-gradient(to bottom, transparent, white 4%, white 96%, transparent);
    mask-composite: intersect;
  }

  .watermark-pin {
    position: absolute;
    transform: translate(-50%, -50%);
    width: 7%;
    aspect-ratio: 1;
    border-radius: 50%;
    background: #e11d48;
    box-shadow: 0 0 0 1.5px rgba(255, 255, 255, 0.9);
  }

  .watermark-caption {
    margin: 4px 0 0;
    color: #fff;
    font-weight: 400;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    text-shadow: 0 1px 4px rgba(0, 0, 0, 0.8);
  }

  .watermark-resize {
    right: -8px;
    bottom: -8px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.45);
  }
</style>
