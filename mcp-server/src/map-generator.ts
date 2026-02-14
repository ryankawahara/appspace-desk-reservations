/**
 * Map Generator Module
 * 
 * Generates annotated floor maps showing room availability and recommendations.
 */

import { writeFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Cache directory for map images
const CACHE_DIR = join(__dirname, '..', 'cache');
// Fallback directory for pre-downloaded floor maps
const FALLBACK_DIR = join(__dirname, '..', 'fallback');

interface MapConfig {
  cdnBase: string;
  contentId: string;
  layerSettingId: string;
  floorMaps: Record<string, {
    floorPlanContentId: string;
    svgPath: string;
    width: number;
    height: number;
  }>;
}

interface RoomLocation {
  name: string;
  shortName: string;
  x: number;
  y: number;
  type: 'conference' | 'huddle' | 'desk' | 'other';
  isAvailable?: boolean;
  isRecommended?: boolean;
  isUserDesk?: boolean;
}

interface POINode {
  setting: {
    name: string;
    subType?: string;
    type?: string;
  };
  geoJSON?: {
    geometry?: {
      type?: string;
      coordinates?: number[][] | number[][][];
    };
  };
}

/**
 * Calculate the centroid of a polygon from its coordinates
 * This places the marker in the center of the room, not the upper-left corner
 */
function calculatePolygonCentroid(coordinates: number[][] | number[][][] | undefined | null): { x: number; y: number } | null {
  if (!coordinates || !Array.isArray(coordinates) || coordinates.length === 0) {
    return null;
  }

  // Handle nested polygon coordinates (GeoJSON format: [[[x,y], [x,y], ...]])
  let points: number[][] = coordinates as number[][];
  
  // Check if first element is also an array of arrays (nested polygon)
  if (Array.isArray(coordinates[0]) && Array.isArray(coordinates[0][0])) {
    points = coordinates[0] as number[][];
  }

  if (!Array.isArray(points) || points.length === 0) {
    return null;
  }

  let sumX = 0;
  let sumY = 0;
  let count = 0;

  for (const point of points) {
    if (Array.isArray(point) && point.length >= 2 && typeof point[0] === 'number' && typeof point[1] === 'number') {
      sumX += point[0];
      sumY += point[1];
      count++;
    }
  }

  if (count === 0) {
    return null;
  }

  return {
    x: sumX / count,
    y: sumY / count,
  };
}

/**
 * Fetch the floor SVG from the CDN
 */
async function fetchFloorSVG(mapConfig: MapConfig, floorPattern: string): Promise<string | null> {
  const floorMap = mapConfig.floorMaps[floorPattern];
  if (!floorMap) {
    console.error(`No map configuration found for floor ${floorPattern}`);
    return null;
  }

  const svgUrl = `${mapConfig.cdnBase}/${mapConfig.contentId}/${floorMap.floorPlanContentId}/${floorMap.svgPath}`;
  
  // Check cache first
  const cacheFile = join(CACHE_DIR, `floor_${floorPattern}_base.svg`);
  if (existsSync(cacheFile)) {
    try {
      return await readFile(cacheFile, 'utf-8');
    } catch {
      // Cache read failed, fetch fresh
    }
  }

  try {
    const response = await fetch(svgUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': 'https://disney.cloud.appspace.com/',
      },
    });

    if (!response.ok) {
      console.error(`Failed to fetch floor SVG: ${response.status}`);
      // Try fallback
      return await loadFallbackSVG(floorPattern);
    }

    const svgContent = await response.text();
    
    // Ensure cache directory exists
    await mkdir(CACHE_DIR, { recursive: true });
    
    // Cache the SVG
    await writeFile(cacheFile, svgContent);
    
    return svgContent;
  } catch (error) {
    console.error('Error fetching floor SVG:', error);
    // Try fallback
    return await loadFallbackSVG(floorPattern);
  }
}

/**
 * Load a fallback SVG from the fallback directory
 */
async function loadFallbackSVG(floorPattern: string): Promise<string | null> {
  const fallbackFile = join(FALLBACK_DIR, `floor_${floorPattern}_base.svg`);
  if (existsSync(fallbackFile)) {
    try {
      console.error(`Using fallback SVG for floor ${floorPattern}`);
      return await readFile(fallbackFile, 'utf-8');
    } catch (error) {
      console.error('Error reading fallback SVG:', error);
    }
  }
  return null;
}

/**
 * Fetch POI/node data for a floor from the Appspace API
 * Caches the data locally since room locations rarely change
 */
async function fetchFloorNodes(
  floorId: string,
  layerSettingId: string,
  token: string,
  host: string
): Promise<POINode[]> {
  // Check cache first (POI data is cached for 7 days)
  const cacheFile = join(CACHE_DIR, `floor_${floorId}_nodes.json`);
  const cacheMaxAge = 7 * 24 * 60 * 60 * 1000; // 7 days

  try {
    if (existsSync(cacheFile)) {
      const { stat } = await import('fs/promises');
      const stats = await stat(cacheFile);
      const age = Date.now() - stats.mtime.getTime();
      
      if (age < cacheMaxAge) {
        const cached = await readFile(cacheFile, 'utf-8');
        const nodes = JSON.parse(cached) as POINode[];
        if (nodes.length > 0) {
          console.error(`Using cached POI data (${nodes.length} nodes, age: ${Math.round(age / 3600000)}h)`);
          return nodes;
        }
      }
    }
  } catch {
    // Cache read failed, fetch fresh
  }

  const allNodes: POINode[] = [];
  let page = 1;
  const limit = 250;

  try {
    while (true) {
      const start = (page - 1) * limit;
      const url = `${host}/api/v3/maps/floors/${floorId}/layers/settings/${layerSettingId}/nodes/settings?start=${start}&page=${page}&limit=${limit}&pagecount=${limit}`;
      
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'token': token,
        },
      });

      if (!response.ok) {
        console.error(`Failed to fetch floor nodes page ${page}: ${response.status}`);
        break;
      }

      const data = await response.json() as { items?: POINode[]; size?: number };
      
      if (!data.items || data.items.length === 0) {
        break;
      }

      allNodes.push(...data.items);

      // Check if we've fetched all items
      if (data.size && allNodes.length >= data.size) {
        break;
      }

      // Safety limit
      if (page > 10) {
        break;
      }

      page++;
    }

    // Cache the nodes data
    if (allNodes.length > 0) {
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(cacheFile, JSON.stringify(allNodes));
      console.error(`Cached ${allNodes.length} POI nodes for floor ${floorId}`);
    }
  } catch (error) {
    console.error('Error fetching floor nodes:', error);
  }

  return allNodes;
}

/**
 * Parse POI nodes to extract room locations with centered coordinates
 */
function parseRoomLocations(nodes: POINode[], roomsToHighlight: Set<string>, userDesk?: string): RoomLocation[] {
  const locations: RoomLocation[] = [];

  for (const node of nodes) {
    const name = node.setting?.name || '';
    if (!name) continue;

    // Extract short name (e.g., "08W-134" from "!CR NYNY 7 HUDSON 08W-134")
    const shortName = name
      .replace('!CR NYNY 7 HUDSON ', '')
      .replace('!CAL NYNY 7 HUDSON ', '')
      .replace('!CR ', '')
      .replace('!CAL ', '');

    // Calculate centroid of the polygon (not upper-left corner)
    const coordinates = node.geoJSON?.geometry?.coordinates;
    if (!coordinates) continue;

    const centroid = calculatePolygonCentroid(coordinates);
    if (!centroid) continue;

    // Determine type
    let type: RoomLocation['type'] = 'other';
    const subType = node.setting?.subType?.toLowerCase() || '';
    const nodeType = node.setting?.type?.toLowerCase() || '';

    if (subType.includes('huddle') || nodeType === 'space') {
      type = 'huddle';
    } else if (name.startsWith('!CR')) {
      type = 'conference';
    } else if (shortName.match(/^\d{2}[EW]-\d+-[A-Z]$/)) {
      type = 'desk';
    }

    // Check if this room should be highlighted
    const isHighlighted = roomsToHighlight.has(shortName);
    const isUserDesk = userDesk && shortName === userDesk;

    locations.push({
      name,
      shortName,
      x: centroid.x,
      y: centroid.y,
      type,
      isRecommended: isHighlighted,
      isUserDesk: isUserDesk || false,
    });
  }

  return locations;
}

/**
 * Generate SVG markers for rooms
 * @param locations - All room locations from POI data
 * @param topRecommendations - Best recommendations (green markers, on top)
 * @param additionalSuggestions - Other available rooms (yellow markers, behind)
 * @param userDesk - User's desk location
 */
function generateMarkers(
  locations: RoomLocation[], 
  topRecommendations: string[], 
  additionalSuggestions: string[],
  userDesk?: string
): string {
  const markers: string[] = [];

  // Find user desk location
  const deskLocation = userDesk ? locations.find(l => l.shortName === userDesk) : null;
  
  // Find room locations
  const topLocations = locations.filter(l => topRecommendations.includes(l.shortName));
  const additionalLocations = locations.filter(l => additionalSuggestions.includes(l.shortName));
  
  // Add markers for ADDITIONAL suggestions FIRST (yellow, behind green)
  for (const room of additionalLocations) {
    const typeLabel = room.type === 'huddle' ? '(H)' : '(C)';
    markers.push(`
  <circle cx="${room.x}" cy="${room.y}" r="7" fill="#eab308" stroke="white" stroke-width="1.5" opacity="0.9"/>
  <text x="${room.x}" y="${room.y + 2.5}" text-anchor="middle" fill="white" font-size="6" font-weight="bold">${typeLabel}</text>
  <text x="${room.x}" y="${room.y - 10}" text-anchor="middle" fill="#a16207" font-size="6" font-weight="bold" style="text-shadow: 1px 1px 2px white, -1px -1px 2px white, 1px -1px 2px white, -1px 1px 2px white;">${room.shortName}</text>
`);
  }

  // Add markers for TOP recommendations (green, on top)
  for (const room of topLocations) {
    const typeLabel = room.type === 'huddle' ? '(HUDDLE)' : '(CONF)';
    markers.push(`
  <circle cx="${room.x}" cy="${room.y}" r="8" fill="#16a34a" stroke="white" stroke-width="2"/>
  <text x="${room.x}" y="${room.y + 3}" text-anchor="middle" fill="white" font-size="8" font-weight="bold">✓</text>
  <text x="${room.x}" y="${room.y - 12}" text-anchor="middle" fill="#16a34a" font-size="7" font-weight="bold" style="text-shadow: 1px 1px 2px white, -1px -1px 2px white, 1px -1px 2px white, -1px 1px 2px white;">${room.shortName}</text>
  <text x="${room.x}" y="${room.y - 5}" text-anchor="middle" fill="#16a34a" font-size="5" style="text-shadow: 1px 1px 2px white, -1px -1px 2px white, 1px -1px 2px white, -1px 1px 2px white;">${typeLabel}</text>
`);
  }
  
  // Add marker for user desk LAST (on top of everything)
  if (deskLocation) {
    markers.push(`
  <circle cx="${deskLocation.x}" cy="${deskLocation.y}" r="10" fill="#2563eb" stroke="white" stroke-width="2"/>
  <text x="${deskLocation.x}" y="${deskLocation.y + 4}" text-anchor="middle" fill="white" font-size="10" font-weight="bold">★</text>
  <text x="${deskLocation.x}" y="${deskLocation.y - 14}" text-anchor="middle" fill="#2563eb" font-size="7" font-weight="bold" style="text-shadow: 1px 1px 2px white, -1px -1px 2px white, 1px -1px 2px white, -1px 1px 2px white;">YOUR DESK</text>
  <text x="${deskLocation.x}" y="${deskLocation.y - 7}" text-anchor="middle" fill="#2563eb" font-size="6" style="text-shadow: 1px 1px 2px white, -1px -1px 2px white, 1px -1px 2px white, -1px 1px 2px white;">${deskLocation.shortName}</text>
`);
  }

  return markers.join('\n');
}

/**
 * Generate a legend for the map
 */
function generateLegend(dateStr: string, timeRange: string): string {
  return `
  <rect x="500" y="330" width="210" height="50" fill="white" stroke="#ccc" rx="5" opacity="0.95"/>
  <text x="510" y="345" font-size="7" font-weight="bold" fill="#333">${dateStr} · ${timeRange}</text>
  <circle cx="515" cy="358" r="4" fill="#2563eb"/>
  <text x="525" y="361" font-size="6" fill="#333">Your desk</text>
  <circle cx="590" cy="358" r="4" fill="#16a34a"/>
  <text x="600" y="361" font-size="6" fill="#333">Top pick</text>
  <circle cx="660" cy="358" r="4" fill="#eab308"/>
  <text x="670" y="361" font-size="6" fill="#333">Also available</text>
`;
}

/**
 * Generate an annotated floor map
 */
export async function generateAnnotatedMap(options: {
  floorPattern: string;
  floorId: string;
  topRecommendations: string[];
  additionalSuggestions?: string[];
  userDesk?: string;
  dateStr: string;
  timeRange: string;
  mapConfig: MapConfig;
  token: string;
  host: string;
}): Promise<string | null> {
  const { floorPattern, floorId, topRecommendations, additionalSuggestions = [], userDesk, dateStr, timeRange, mapConfig, token, host } = options;

  // Ensure cache directory exists
  await mkdir(CACHE_DIR, { recursive: true });

  // Fetch base SVG
  const baseSvg = await fetchFloorSVG(mapConfig, floorPattern);
  if (!baseSvg) {
    console.error('Failed to fetch base SVG');
    return null;
  }

  // Fetch POI nodes
  const nodes = await fetchFloorNodes(floorId, mapConfig.layerSettingId, token, host);
  if (nodes.length === 0) {
    console.error('No POI nodes found');
    return null;
  }

  // Parse room locations
  const allRooms = new Set([...topRecommendations, ...additionalSuggestions]);
  const locations = parseRoomLocations(nodes, allRooms, userDesk);

  // Generate markers (additional suggestions first/behind, then top recommendations on top)
  const markers = generateMarkers(locations, topRecommendations, additionalSuggestions, userDesk);
  const legend = generateLegend(dateStr, timeRange);

  // Create annotated SVG
  const annotatedSvg = baseSvg.replace(
    '</svg>',
    `<g id="annotations">\n${markers}\n${legend}\n</g>\n</svg>`
  );

  // Save annotated SVG
  const timestamp = Date.now();
  const svgPath = join(CACHE_DIR, `floor_${floorPattern}_annotated_${timestamp}.svg`);
  await writeFile(svgPath, annotatedSvg);

  // Convert to PNG using qlmanage (macOS)
  const pngPath = join(CACHE_DIR, `floor_${floorPattern}_annotated_${timestamp}.png`);
  try {
    execSync(`qlmanage -t -s 1500 -o "${CACHE_DIR}" "${svgPath}" 2>/dev/null`, {
      encoding: 'utf-8',
    });
    
    // qlmanage adds .png to the filename
    const generatedPng = `${svgPath}.png`;
    if (existsSync(generatedPng)) {
      // Rename to our expected path
      const { rename } = await import('fs/promises');
      await rename(generatedPng, pngPath);
    }
  } catch (error) {
    console.error('Failed to convert SVG to PNG:', error);
    // Return SVG path if PNG conversion fails
    return svgPath;
  }

  const finalPath = existsSync(pngPath) ? pngPath : svgPath;
  
  // Automatically open the generated map image (macOS)
  try {
    execSync(`open "${finalPath}"`, { encoding: 'utf-8' });
  } catch {
    // Silently fail if open command doesn't work
  }

  return finalPath;
}

/**
 * Clean up old cached map files (keep only last 10)
 */
export async function cleanupOldMaps(): Promise<void> {
  try {
    const { readdir, unlink, stat } = await import('fs/promises');
    const files = await readdir(CACHE_DIR);
    
    const annotatedFiles = files
      .filter(f => f.includes('_annotated_') && (f.endsWith('.svg') || f.endsWith('.png')))
      .map(f => ({ name: f, path: join(CACHE_DIR, f) }));

    if (annotatedFiles.length <= 20) return;

    // Get file stats and sort by modification time
    const filesWithStats = await Promise.all(
      annotatedFiles.map(async f => {
        const stats = await stat(f.path);
        return { ...f, mtime: stats.mtime.getTime() };
      })
    );

    filesWithStats.sort((a, b) => b.mtime - a.mtime);

    // Delete old files (keep 20 most recent)
    for (const file of filesWithStats.slice(20)) {
      await unlink(file.path);
    }
  } catch {
    // Ignore cleanup errors
  }
}

