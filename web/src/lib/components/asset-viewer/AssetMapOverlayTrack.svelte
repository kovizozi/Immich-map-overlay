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
    /** Real capture instant (from `fileCreatedAt`), used for chronological order and time-proximity matching. */
    takenAt: number;
    /** Local calendar day the photo was taken on (from `localDateTime`), e.g. "2026-08-09". */
    dayKey: string;
    /** Position within `dayKey`'s 24h, from 0 (midnight) to 1, used to shade points taken later in the day darker. */
    dayFraction: number;
    /** True if `lat`/`lng` were guessed from a nearby-in-time asset rather than this asset's own EXIF GPS. */
    estimated: boolean;
  }

  export interface DayLegendEntry {
    key: string;
    label: string;
    color: string;
  }

  // Hues cycled across the days present in an album, spaced for visual distinctness.
  const DAY_HUES = [217, 24, 142, 291, 48, 199, 340, 88];

  const colorForDay = (dayIndex: number, dayFraction: number) => {
    const hue = DAY_HUES[dayIndex % DAY_HUES.length];
    // Same hue all day; lighter in the morning, darker in the evening.
    const lightness = 72 - dayFraction * 34;
    return `hsl(${hue}, 70%, ${lightness}%)`;
  };

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
  import { locale, mapSettings } from '$lib/stores/preferences.store';
  import { navigate } from '$lib/utils/navigation';
  import { Icon, Theme, themeManager } from '@immich/ui';
  import { mdiMapMarker } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { LngLatBounds, type Map as MaplibreMap, type MapLibreEvent } from 'maplibre-gl';
  import { MapLibre, Marker } from 'svelte-maplibre';

  interface Props {
    /** Sorted ascending by `takenAt`. */
    points: TrackPoint[];
    activeAssetId: string;
    /** Called whenever the set of days represented by the currently visible points changes. */
    onLegendChange?: (days: DayLegendEntry[]) => void;
  }

  let { points, activeAssetId, onLegendChange }: Props = $props();

  let map: MaplibreMap | undefined = $state();

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

  // Stable per-day color assignment computed from the whole album (not just the visible subset), so a
  // given day always renders the same hue regardless of which points are currently shown.
  const dayOrder = $derived.by(() => {
    const days = [...new Set(points.map((point) => point.dayKey))].sort();
    return new Map(days.map((day, index) => [day, index]));
  });

  const colorOf = (point: TrackPoint) => colorForDay(dayOrder.get(point.dayKey) ?? 0, point.dayFraction);

  const legendDays = $derived.by(() => {
    const seen = new Set<string>();
    const days: DayLegendEntry[] = [];
    for (const point of visiblePoints) {
      if (seen.has(point.dayKey)) {
        continue;
      }
      seen.add(point.dayKey);
      days.push({
        key: point.dayKey,
        color: colorForDay(dayOrder.get(point.dayKey) ?? 0, 0.5),
        label: DateTime.fromISO(point.dayKey, { locale: $locale }).toFormat('MM.dd ccc'),
      });
    }
    return days.sort((a, b) => a.key.localeCompare(b.key));
  });

  $effect(() => {
    onLegendChange?.(legendDays);
  });
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
        <div
          class="size-3 rounded-full shadow-sm {point.estimated
            ? 'border-2 border-dashed border-white opacity-70'
            : 'border border-white/70'}"
          style:background-color={colorOf(point)}
          title={point.estimated ? 'Estimated location (no GPS data on this photo)' : undefined}
        ></div>
      </Marker>
    {/if}
  {/each}
</MapLibre>
