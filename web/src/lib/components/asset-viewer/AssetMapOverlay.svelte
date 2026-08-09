<script lang="ts">
  import { timeToLoadTheMap } from '$lib/constants';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { assetMapOverlaySettings } from '$lib/stores/asset-map-overlay.store';
  import { mediaQueryManager } from '$lib/stores/media-query-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { delay } from '$lib/utils/asset-utils';
  import { fromISODateTime, fromISODateTimeUTC } from '$lib/utils/timeline-util';
  import { type AlbumResponseDto, type AssetResponseDto, searchAssets } from '@immich/sdk';
  import { Icon, IconButton, LoadingSpinner } from '@immich/ui';
  import { mdiClose, mdiDragHorizontalVariant, mdiMapOutline, mdiResizeBottomRight } from '@mdi/js';
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { TrackPoint } from './AssetMapOverlayTrack.svelte';

  interface Props {
    asset: AssetResponseDto;
    album?: AlbumResponseDto;
  }

  let { asset, album }: Props = $props();

  // Height of the asset viewer top navigation bar, so the overlay can never be dragged underneath it.
  const navBarHeight = 64;

  const MIN_WIDTH = 200;
  const MIN_HEIGHT = 140;
  const MAX_WIDTH = 480;
  const MAX_HEIGHT = 360;

  let overlayWidth = $state(0);
  let overlayHeight = $state(0);
  let dragPosition = $state<{ right: number; bottom: number }>();
  let dragOrigin: { x: number; y: number; right: number; bottom: number } | undefined;
  let resizeSize = $state<{ width: number; height: number }>();
  let resizeOrigin: { x: number; y: number; width: number; height: number } | undefined;

  let albumTrackPoints = $state<TrackPoint[]>([]);
  let albumTrackAbortController: AbortController | undefined;

  const latlng = $derived(
    (() => {
      const lat = asset.exifInfo?.latitude;
      const lng = asset.exifInfo?.longitude;

      if (lat && lng) {
        return { lat: Number(lat.toFixed(7)), lng: Number(lng.toFixed(7)) };
      }
    })(),
  );

  // Reverse geocoding found nothing nearby (e.g. open water) — zoom out further for context, since
  // a tight zoom would otherwise show nothing but an undifferentiated tile.
  const soloZoom = $derived(asset.exifInfo?.city || asset.exifInfo?.state || asset.exifInfo?.country ? 12.5 : 6);

  const showAlbumTrack = $derived(album !== undefined && albumTrackPoints.length > 0);
  const hasContent = $derived(showAlbumTrack || !!latlng);

  const loadAlbumTrack = async (albumId: string) => {
    if (albumTrackAbortController) {
      albumTrackAbortController.abort();
    }
    albumTrackAbortController = new AbortController();

    try {
      const { assets } = await searchAssets(
        { ...authManager.params, metadataSearchDto: { albumIds: [albumId], size: 1000, withExif: true } },
        { signal: albumTrackAbortController.signal },
      );

      albumTrackPoints = assets.items
        .filter((item) => item.exifInfo?.latitude && item.exifInfo.longitude)
        .map((item) => ({
          id: item.id,
          lat: item.exifInfo!.latitude!,
          lng: item.exifInfo!.longitude!,
          takenAt: new Date(item.fileCreatedAt).getTime(),
        }))
        .sort((a, b) => a.takenAt - b.takenAt);
    } catch (error) {
      // Falls back to the single-asset view below - log so a real failure (as opposed to an album
      // with no GPS-tagged assets, which never reaches this catch) is still visible for diagnosis.
      console.error('Failed to load album track markers', error);
      albumTrackPoints = [];
    }
  };

  $effect(() => {
    if (album) {
      void loadAlbumTrack(album.id);
    } else {
      albumTrackPoints = [];
    }
  });

  onDestroy(() => {
    if (albumTrackAbortController) {
      albumTrackAbortController.abort();
    }
  });

  const timeZone = $derived(asset.exifInfo?.timeZone ?? undefined);
  const dateTime = $derived(
    timeZone && asset.exifInfo?.dateTimeOriginal
      ? fromISODateTime(asset.exifInfo.dateTimeOriginal, timeZone)
      : fromISODateTimeUTC(asset.localDateTime),
  );
  const dateTimeLabel = $derived(
    dateTime.isValid
      ? dateTime.toLocaleString(
          { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
          { locale: $locale },
        )
      : undefined,
  );

  const locationLabel = $derived(
    [[asset.exifInfo?.city, asset.exifInfo?.country].filter(Boolean).join(', ') || $t('location'), dateTimeLabel]
      .filter(Boolean)
      .join(' · '),
  );

  const defaultSize = $derived(
    mediaQueryManager.pointerCoarse ? { width: 320, height: 220 } : { width: 280, height: 168 },
  );

  const size = $derived(
    resizeSize ?? {
      width: $assetMapOverlaySettings.width ?? defaultSize.width,
      height: $assetMapOverlaySettings.height ?? defaultSize.height,
    },
  );

  const position = $derived(
    dragPosition ?? { right: $assetMapOverlaySettings.right, bottom: $assetMapOverlaySettings.bottom },
  );

  // window.innerWidth/innerHeight can be inaccurate on mobile browsers whose address bar/toolbar
  // shows or hides depending on the page content (e.g. a letterboxed vs. full-bleed photo), leaving
  // the overlay clamped against a viewport size that no longer matches what's actually visible.
  // visualViewport tracks the real, currently-visible area and is preferred when available.
  const viewportWidth = () => globalThis.visualViewport?.width ?? innerWidth;
  const viewportHeight = () => globalThis.visualViewport?.height ?? innerHeight;

  const clampPosition = ({ right, bottom }: { right: number; bottom: number }) => ({
    right: Math.min(Math.max(right, 0), Math.max(viewportWidth() - overlayWidth, 0)),
    bottom: Math.min(Math.max(bottom, 0), Math.max(viewportHeight() - overlayHeight - navBarHeight, 0)),
  });

  const clampSize = ({ width, height }: { width: number; height: number }) => ({
    width: Math.min(Math.max(width, MIN_WIDTH), MAX_WIDTH, viewportWidth() - 32),
    height: Math.min(Math.max(height, MIN_HEIGHT), MAX_HEIGHT, viewportHeight() - navBarHeight - 32),
  });

  const onPointerDown = (event: PointerEvent) => {
    dragOrigin = { x: event.clientX, y: event.clientY, ...position };
    dragPosition = position;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!dragOrigin) {
      return;
    }

    dragPosition = clampPosition({
      right: dragOrigin.right + dragOrigin.x - event.clientX,
      bottom: dragOrigin.bottom + dragOrigin.y - event.clientY,
    });
  };

  const onPointerUp = () => {
    if (!dragOrigin) {
      return;
    }

    dragOrigin = undefined;

    // Only persist once the drag is over, instead of on every pointer move.
    if (dragPosition) {
      $assetMapOverlaySettings = { ...$assetMapOverlaySettings, ...dragPosition };
      dragPosition = undefined;
    }
  };

  const onResizePointerDown = (event: PointerEvent) => {
    resizeOrigin = { x: event.clientX, y: event.clientY, ...size };
    resizeSize = size;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const onResizePointerMove = (event: PointerEvent) => {
    if (!resizeOrigin) {
      return;
    }

    resizeSize = clampSize({
      width: resizeOrigin.width + (event.clientX - resizeOrigin.x),
      height: resizeOrigin.height + (event.clientY - resizeOrigin.y),
    });
  };

  const onResizePointerUp = () => {
    if (!resizeOrigin) {
      return;
    }

    resizeOrigin = undefined;

    if (resizeSize) {
      $assetMapOverlaySettings = { ...$assetMapOverlaySettings, ...resizeSize };
      resizeSize = undefined;
    }
  };

  const onWindowResize = () => {
    if (!overlayWidth) {
      return;
    }

    const clampedPosition = clampPosition(position);
    const clampedSize = clampSize(size);
    const settings = { ...$assetMapOverlaySettings };
    let changed = false;

    if (clampedPosition.right !== position.right || clampedPosition.bottom !== position.bottom) {
      Object.assign(settings, clampedPosition);
      changed = true;
    }
    if (clampedSize.width !== size.width || clampedSize.height !== size.height) {
      Object.assign(settings, clampedSize);
      changed = true;
    }
    if (changed) {
      $assetMapOverlaySettings = settings;
    }
  };

  onMount(() => {
    // Mobile browsers resize the visible viewport (address bar show/hide) without always firing
    // the window's own resize event, so the overlay can otherwise be clamped against a stale size.
    globalThis.visualViewport?.addEventListener('resize', onWindowResize);
    return () => globalThis.visualViewport?.removeEventListener('resize', onWindowResize);
  });

  const setVisible = (visible: boolean) => {
    $assetMapOverlaySettings = { ...$assetMapOverlaySettings, visible };
  };
</script>

<svelte:window onresize={onWindowResize} />

{#if hasContent && featureFlagsManager.value.map}
  {#if $assetMapOverlaySettings.visible}
    <div
      class="absolute z-30 overflow-hidden rounded-2xl border border-gray-500/20 bg-light shadow-lg"
      style:right="{position.right}px"
      style:bottom="{position.bottom}px"
      bind:clientWidth={overlayWidth}
      bind:clientHeight={overlayHeight}
    >
      <div class="flex h-7 items-center gap-1 ps-1 pe-0.5">
        <button
          type="button"
          class="flex h-full min-w-0 grow cursor-move touch-none items-center gap-1 text-dark"
          aria-label={$t('location')}
          onpointerdown={onPointerDown}
          onpointermove={onPointerMove}
          onpointerup={onPointerUp}
          onpointercancel={onPointerUp}
        >
          <Icon icon={mdiDragHorizontalVariant} size="18" class="shrink-0 opacity-60" />
          <p class="truncate text-xs">{locationLabel}</p>
        </button>

        <IconButton
          icon={mdiClose}
          size="tiny"
          shape="round"
          color="secondary"
          variant="ghost"
          title={$t('close')}
          aria-label={$t('close')}
          onclick={() => setVisible(false)}
        />
      </div>

      <div class="relative" style:width="{size.width}px" style:height="{size.height}px">
        {#if showAlbumTrack}
          {#await import('./AssetMapOverlayTrack.svelte')}
            {#await delay(timeToLoadTheMap) then}
              <div class="flex size-full items-center justify-center">
                <LoadingSpinner />
              </div>
            {/await}
          {:then { default: AssetMapOverlayTrack }}
            <AssetMapOverlayTrack points={albumTrackPoints} activeAssetId={asset.id} />
          {/await}
        {:else if latlng}
          {#await import('$lib/components/shared-components/map/Map.svelte')}
            {#await delay(timeToLoadTheMap) then}
              <!-- show the loading spinner only if loading the map takes too much time -->
              <div class="flex size-full items-center justify-center">
                <LoadingSpinner />
              </div>
            {/await}
          {:then { default: Map }}
            <Map
              mapMarkers={[
                {
                  lat: latlng.lat,
                  lon: latlng.lng,
                  id: asset.id,
                  city: asset.exifInfo?.city ?? null,
                  state: asset.exifInfo?.state ?? null,
                  country: asset.exifInfo?.country ?? null,
                },
              ]}
              center={latlng}
              zoom={soloZoom}
              simplified
              useLocationPin
              showSettings={false}
              showSimpleControls={false}
            />
          {/await}
        {/if}

        <button
          type="button"
          class="absolute inset-e-0 bottom-0 flex size-4 cursor-nwse-resize touch-none items-end justify-end text-dark opacity-50 hover:opacity-90"
          aria-label={$t('resize')}
          onpointerdown={onResizePointerDown}
          onpointermove={onResizePointerMove}
          onpointerup={onResizePointerUp}
          onpointercancel={onResizePointerUp}
        >
          <Icon icon={mdiResizeBottomRight} size="14" />
        </button>
      </div>
    </div>
  {:else}
    <div
      class="absolute z-30"
      style:right="{position.right}px"
      style:bottom="{position.bottom}px"
      bind:clientWidth={overlayWidth}
      bind:clientHeight={overlayHeight}
    >
      <IconButton
        icon={mdiMapOutline}
        shape="round"
        color="secondary"
        variant="ghost"
        class="dark text-white"
        title={$t('map')}
        aria-label={$t('map')}
        onclick={() => setVisible(true)}
      />
    </div>
  {/if}
{/if}
