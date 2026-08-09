<script lang="ts" module>
  import mapboxRtlUrl from '@mapbox/mapbox-gl-rtl-text?url';
  import { addProtocol, setRTLTextPlugin } from 'maplibre-gl';
  import { Protocol } from 'pmtiles';

  // Mirrors shared-components/map/Map.svelte's module-level setup: this component renders its own
  // MapLibre instance instead of reusing that one, so it needs the same one-time protocol registration.
  let protocol = new Protocol();
  void addProtocol('pmtiles', protocol.tile);
  void setRTLTextPlugin(mapboxRtlUrl, true);

  export interface TrackPoint {
    id: string;
    lat: number;
    lng: number;
    takenAt: number;
  }

  const EARLIEST_COLOR: [number, number, number] = [37, 99, 235]; // blue-600, earliest asset
  const LATEST_COLOR: [number, number, number] = [249, 115, 22]; // orange-500, latest asset

  const lerpColor = ([r1, g1, b1]: number[], [r2, g2, b2]: number[], ratio: number) =>
    `rgb(${Math.round(r1 + (r2 - r1) * ratio)}, ${Math.round(g1 + (g2 - g1) * ratio)}, ${Math.round(b1 + (b2 - b1) * ratio)})`;

  // How many of the nearest points (besides the active asset) to show before the user has explored the map.
  const NEARBY_COUNT = 5;
  const EARTH_RADIUS_KM = 6371;
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

  const haversineDistanceKm = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
    const dLat = toRadians(b.lat - a.lat);
    const dLng = toRadians(b.lng - a.lng);
    const sinDLat = Math.sin(dLat / 2);
    const sinDLng = Math.sin(dLng / 2);
    const h = sinDLat ** 2 + Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * sinDLng ** 2;
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
  };
</script>

<script lang="ts">
  import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
  import { mapSettings } from '$lib/stores/preferences.store';
  import { navigate } from '$lib/utils/navigation';
  import { Icon, Theme, themeManager } from '@immich/ui';
  import { mdiMapMarker } from '@mdi/js';
  import { LngLatBounds, type Map, type MapLibreEvent } from 'maplibre-gl';
  import { MapLibre, Marker } from 'svelte-maplibre';

  interface Props {
    /** Sorted ascending by `takenAt`. */
    points: TrackPoint[];
    activeAssetId: string;
  }

  let { points, activeAssetId }: Props = $props();

  let map: Map | undefined = $state();

  // Tracks whether the user has actually explored the map (as opposed to the initial programmatic
  // fitBounds), so a large album doesn't immediately reveal every point and zoom out past the vicinity
  // of the active asset. Reset whenever the active asset changes so navigating between photos always
  // starts focused on the new one.
  let hasExploredMap = $state(false);
  let viewportBounds = $state<LngLatBounds>();

  $effect(() => {
    activeAssetId;
    hasExploredMap = false;
    viewportBounds = undefined;
  });

  $effect(() => {
    if (!map) {
      return;
    }

    const currentMap = map;
    const onUserInteraction = (event: MapLibreEvent<unknown>) => {
      if (event.originalEvent) {
        hasExploredMap = true;
      }
    };
    const onMoveEnd = () => {
      viewportBounds = currentMap.getBounds();
    };

    currentMap.on('dragstart', onUserInteraction);
    currentMap.on('zoomstart', onUserInteraction);
    currentMap.on('moveend', onMoveEnd);

    return () => {
      currentMap.off('dragstart', onUserInteraction);
      currentMap.off('zoomstart', onUserInteraction);
      currentMap.off('moveend', onMoveEnd);
    };
  });

  const mapTheme = $derived($mapSettings.allowDarkMode ? themeManager.value : Theme.Light);
  const styleUrl = $derived(
    mapTheme === Theme.Dark ? serverConfigManager.value.mapDarkStyleUrl : serverConfigManager.value.mapLightStyleUrl,
  );

  const anchorPoint = $derived(points.find((point) => point.id === activeAssetId) ?? points[0]);

  // The active asset plus its nearest neighbors, shown before the user pans/zooms the map themselves.
  const nearbyPoints = $derived.by(() => {
    if (!anchorPoint) {
      return [];
    }

    const others = points
      .filter((point) => point.id !== anchorPoint.id)
      .sort((a, b) => haversineDistanceKm(anchorPoint, a) - haversineDistanceKm(anchorPoint, b))
      .slice(0, NEARBY_COUNT);

    return [anchorPoint, ...others];
  });

  const visiblePoints = $derived(
    hasExploredMap && viewportBounds
      ? points.filter((point) => viewportBounds!.contains([point.lng, point.lat]))
      : nearbyPoints,
  );

  const bounds = $derived.by(() => {
    if (nearbyPoints.length === 0) {
      return;
    }

    const box = new LngLatBounds();
    for (const point of nearbyPoints) {
      box.extend([point.lng, point.lat]);
    }
    return box;
  });

  const colorOf = (point: TrackPoint) => {
    const min = points[0].takenAt;
    const max = points.at(-1)!.takenAt;
    const ratio = max === min ? 0 : (point.takenAt - min) / (max - min);
    return lerpColor(EARLIEST_COLOR, LATEST_COLOR, ratio);
  };
</script>

<MapLibre
  style={styleUrl}
  class="size-full"
  {bounds}
  fitBoundsOptions={{ padding: 24, maxZoom: 15 }}
  attributionControl={false}
  bind:map
>
  {#each visiblePoints as point (point.id)}
    {#if point.id === activeAssetId}
      <Marker lngLat={[point.lng, point.lat]} zIndex={10}>
        <Icon icon={mdiMapMarker} size="34px" class="translate-y-[calc(5px-50%)] text-primary" />
      </Marker>
    {:else}
      <Marker
        lngLat={[point.lng, point.lat]}
        asButton
        onclick={() => navigate({ targetRoute: 'current', assetId: point.id })}
      >
        <div class="size-3 rounded-full border border-white/70 shadow-sm" style:background-color={colorOf(point)}></div>
      </Marker>
    {/if}
  {/each}
</MapLibre>
