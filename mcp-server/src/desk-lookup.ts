/**
 * Desk Lookup Module
 * Handles loading and resolving desk names to resource IDs
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { AppspaceClient } from './appspace-client.js';

/**
 * Load the desk lookup table from a JSON file
 */
export async function loadDeskLookup(filePath: string): Promise<Map<string, string>> {
  const lookup = new Map<string, string>();

  // Try multiple paths
  const pathsToTry = [
    filePath,
    resolve(process.cwd(), filePath),
    resolve(process.cwd(), '..', filePath),
    resolve(process.cwd(), 'DESK_LOOKUP.json'),
    resolve(process.cwd(), '..', 'DESK_LOOKUP.json'),
  ];

  for (const path of pathsToTry) {
    if (existsSync(path)) {
      try {
        const content = await readFile(path, 'utf-8');
        const data = JSON.parse(content) as Record<string, string>;
        
        for (const [name, id] of Object.entries(data)) {
          lookup.set(name.toLowerCase(), id);
          lookup.set(name, id); // Also keep original case
        }
        
        console.error(`Loaded ${lookup.size / 2} desk mappings from ${path}`);
        return lookup;
      } catch (error) {
        console.error(`Warning: Could not load desk lookup from ${path}:`, error);
      }
    }
  }

  console.error('Warning: No DESK_LOOKUP.json found. Desk name resolution will use API search.');
  return lookup;
}

/**
 * Check if a string looks like a UUID
 */
function isUUID(str: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(str);
}

/**
 * Resolve a resource identifier (name or ID) to a resource ID
 */
export async function resolveResourceId(
  identifier: string,
  lookup: Map<string, string>,
  client: AppspaceClient
): Promise<string | null> {
  // If it's already a UUID, return it directly
  if (isUUID(identifier)) {
    return identifier;
  }

  // Try the lookup table first (case-insensitive)
  const fromLookup = lookup.get(identifier) || lookup.get(identifier.toLowerCase());
  if (fromLookup) {
    return fromLookup;
  }

  // Fall back to API search
  try {
    const result = await client.getResourceByName(identifier);
    if (result.success && result.data) {
      return result.data.id;
    }
  } catch (error) {
    console.error(`Error searching for resource "${identifier}":`, error);
  }

  return null;
}

/**
 * Get desk name from resource ID (reverse lookup)
 */
export function getResourceName(
  resourceId: string,
  lookup: Map<string, string>
): string | null {
  for (const [name, id] of lookup.entries()) {
    if (id === resourceId) {
      return name;
    }
  }
  return null;
}






