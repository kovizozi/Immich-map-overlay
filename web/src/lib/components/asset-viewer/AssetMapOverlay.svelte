<script lang="ts">
  import { timeToLoadTheMap } from '$lib/constants';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { assetMapOverlaySettings } from '$lib/stores/asset-map-overlay.store';
  import { delay } from '$lib/utils/asset-utils';
  import type { AssetResponseDto } from '@immich/sdk';
  import { Icon, IconButton, LoadingSpinner } from '@immich/ui';
  import { mdiClose, mdiDragHorizontalVariant, mdiMapOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    asset: AssetResponseDto;
  }

  let { asset }: Props = $props();

  // Height of the asset viewer top navigation bar, so the overlay can never be dragged underneath it.
  const navBarHeight = 64;

  let overlayWidth = $state(0);
  let overlayHeight = $state(0);
  let dragPosition = $state<{ right: number; bottom: number }>();
  let dragOrigin: { x: number; y: number; right: number; bottom: number } | undefined;

  const latlng = $derived(
    (() => {
      const lat = asset.exifInfo?.latitude;
      const lng = asset.exifInfo?.longitude;

      if (lat && lng) {
        return { lat: Number(lat.toFixed(7)), lng: Number(lng.toFixed(7)) };
      }
    })(),
  );

  const position = $derived(
    dragPosition ?? { right: $assetMapOverlaySettings.right, bottom: $assetMapOverlaySettings.bottom },
  );

  const locationLabel = $derived(
    [asset.exifInfo?.city, asset.exifInfo?.country].filter(Boolean).join(', ') || $t('location'),
  );

  const clampPosition = ({ right, bottom }: { right: number; bottom: number }) => ({
    right: Math.min(Math.max(right, 0), Math.max(innerWidth - overlayWidth, 0)),
    bottom: Math.min(Math.max(bottom, 0), Math.max(innerHeight - overlayHeight - navBarHeight, 0)),
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

  const onResize = () => {
    if (!latlng || !overlayWidth) {
      return;
    }

    const clamped = clampPosition(position);
    if (clamped.right !== position.right || clamped.bottom !== position.bottom) {
      $assetMapOverlaySettings = { ...$assetMapOverlaySettings, ...clamped };
    }
  };

  const setVisible = (visible: boolean) => {
    $assetMapOverlaySettings = { ...$assetMapOverlaySettings, visible };
  };
</script>

<svelte:window onresize={onResize} />

{#if latlng && featureFlagsManager.value.map}
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

      <div class="h-28 w-50 md:h-42 md:w-70">
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
            zoom={12.5}
            simplified
            useLocationPin
            showSettings={false}
            showSimpleControls={false}
          />
        {/await}
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
