#!/usr/bin/env node

/**
 * Appspace Reservations MCP Server
 * 
 * This MCP server provides tools to manage desk and conference room
 * reservations through the Appspace API.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { AppspaceClient, getFullDayRange } from './appspace-client.js';
import { loadDeskLookup, resolveResourceId } from './desk-lookup.js';
import { generateAnnotatedMap, cleanupOldMaps } from './map-generator.js';
import { readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Room configuration types
interface RoomConfig {
  building: {
    name: string;
    prefix: string;
    networkId?: string;
  };
  floors: Record<string, {
    name: string;
    wings: string[];
    pattern: string;
  }>;
  shortcuts: Record<string, string>;
  floorIds?: Record<string, string>;
  mapConfig?: {
    cdnBase: string;
    contentId: string;
    layerSettingId: string;
    floorMaps: Record<string, {
      floorPlanContentId: string;
      svgPath: string;
      width: number;
      height: number;
    }>;
  };
}

// Load room configuration
async function loadRoomConfig(): Promise<RoomConfig> {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const configPath = join(__dirname, '..', 'ROOM_CONFIG.json');
    const data = await readFile(configPath, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Warning: Could not load ROOM_CONFIG.json, using defaults');
    return {
      building: { name: '7 Hudson Square', prefix: '!CR NYNY 7 HUDSON' },
      floors: {},
      shortcuts: {}
    };
  }
}

// Resolve floor shortcut to pattern (e.g., "8W" -> "08W", "8" -> "08")
function resolveFloorPattern(input: string, roomConfig: RoomConfig): string {
  const normalized = input.toUpperCase().replace(/^0+/, ''); // Remove leading zeros
  
  // Check shortcuts first
  if (roomConfig.shortcuts[normalized]) {
    return roomConfig.shortcuts[normalized];
  }
  
  // Try with leading zero
  const withZero = normalized.length === 1 ? `0${normalized}` : normalized;
  if (roomConfig.shortcuts[withZero]) {
    return roomConfig.shortcuts[withZero];
  }
  
  // Return original if no match
  return input;
}

// Environment configuration
const config = {
  host: process.env.APPSPACE_HOST || 'https://disney.cloud.appspace.com',
  token: process.env.APPSPACE_TOKEN || '',
  organizerId: process.env.ORGANIZER_ID || '',
  organizerName: process.env.ORGANIZER_NAME || '',
  organizerEmail: process.env.ORGANIZER_EMAIL || '',
  timezone: process.env.TIMEZONE || 'America/New_York',
  defaultStartTime: process.env.BOOKING_START_TIME || '09:00',
  defaultEndTime: process.env.BOOKING_END_TIME || '17:00',
  deskLookupPath: process.env.DESK_LOOKUP_PATH || './DESK_LOOKUP.json',
};

// Resources that have been converted to offices and should be excluded from availability
// These still appear in Appspace but are no longer bookable spaces
const EXCLUDED_RESOURCES = new Set([
  '08W-118',
  '08W-120',
  '08W-122',
]);

// Helper to check if a resource should be excluded
function isExcludedResource(shortName: string): boolean {
  return EXCLUDED_RESOURCES.has(shortName);
}

/**
 * Check if a resource name is a desk (has a letter suffix like -A, -B, -H)
 * Desks: 08W-125-A, 08W-125-H (format: XXY-NNN-L where L is a letter)
 * Meeting rooms: 08W-460, 08W-134 (format: XXY-NNN with no letter suffix)
 */
function isDesk(resourceName: string): boolean {
  // Desks have a letter suffix: 08W-125-A, 08W-127-B, etc.
  // Meeting rooms don't: 08W-460, 08W-134
  return /\d{2}[EW]-\d+-[A-Z]$/i.test(resourceName);
}

// Validate required configuration
function validateConfig(): void {
  const missing: string[] = [];
  if (!config.token) missing.push('APPSPACE_TOKEN');
  if (!config.organizerId) missing.push('ORGANIZER_ID');
  if (!config.organizerName) missing.push('ORGANIZER_NAME');
  if (!config.organizerEmail) missing.push('ORGANIZER_EMAIL');
  
  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    console.error('Please set these variables before running the MCP server.');
    process.exit(1);
  }
}

// Initialize client
let client: AppspaceClient;
let deskLookup: Map<string, string>;
let roomConfig: RoomConfig;

// Tool definitions
const TOOLS: Tool[] = [
  {
    name: 'reserve_desk',
    description: 'Reserve a desk for a specific date and time. You can specify a desk by name (e.g., "08W-125-H") or resource ID.',
    inputSchema: {
      type: 'object',
      properties: {
        desk: {
          type: 'string',
          description: 'Desk name (e.g., "08W-125-H") or resource ID (UUID)',
        },
        date: {
          type: 'string',
          description: 'Date for the reservation (YYYY-MM-DD format)',
        },
        startTime: {
          type: 'string',
          description: 'Start time (HH:MM format, 24-hour). Defaults to 09:00',
        },
        endTime: {
          type: 'string',
          description: 'End time (HH:MM format, 24-hour). Defaults to 17:00',
        },
        subject: {
          type: 'string',
          description: 'Subject/title for the reservation',
        },
      },
      required: ['desk', 'date'],
    },
  },
  {
    name: 'reserve_room',
    description: 'Reserve a conference room for a specific date and time. You can specify a room by name or resource ID.',
    inputSchema: {
      type: 'object',
      properties: {
        room: {
          type: 'string',
          description: 'Room name or resource ID (UUID)',
        },
        date: {
          type: 'string',
          description: 'Date for the reservation (YYYY-MM-DD format)',
        },
        startTime: {
          type: 'string',
          description: 'Start time (HH:MM format, 24-hour)',
        },
        endTime: {
          type: 'string',
          description: 'End time (HH:MM format, 24-hour)',
        },
        subject: {
          type: 'string',
          description: 'Meeting subject/title',
        },
      },
      required: ['room', 'date', 'startTime', 'endTime'],
    },
  },
  {
    name: 'cancel_reservation',
    description: 'Cancel an existing reservation by its ID',
    inputSchema: {
      type: 'object',
      properties: {
        reservationId: {
          type: 'string',
          description: 'The reservation ID to cancel',
        },
      },
      required: ['reservationId'],
    },
  },
  {
    name: 'modify_reservation',
    description: 'Modify an existing reservation (change time, date, or resource)',
    inputSchema: {
      type: 'object',
      properties: {
        reservationId: {
          type: 'string',
          description: 'The reservation ID to modify',
        },
        date: {
          type: 'string',
          description: 'New date (YYYY-MM-DD format)',
        },
        startTime: {
          type: 'string',
          description: 'New start time (HH:MM format, 24-hour)',
        },
        endTime: {
          type: 'string',
          description: 'New end time (HH:MM format, 24-hour)',
        },
        resource: {
          type: 'string',
          description: 'New desk/room name or resource ID',
        },
        subject: {
          type: 'string',
          description: 'New subject/title',
        },
      },
      required: ['reservationId'],
    },
  },
  {
    name: 'list_reservations',
    description: 'List your current and upcoming reservations',
    inputSchema: {
      type: 'object',
      properties: {
        startDate: {
          type: 'string',
          description: 'Start date for the range (YYYY-MM-DD). Defaults to today.',
        },
        endDate: {
          type: 'string',
          description: 'End date for the range (YYYY-MM-DD). Defaults to 7 days from start.',
        },
        status: {
          type: 'string',
          description: 'Filter by status: all, active, pending, confirmed. Defaults to all.',
        },
      },
      required: [],
    },
  },
  {
    name: 'check_in',
    description: 'Check in to a reservation. Must be within 15 minutes of the start time.',
    inputSchema: {
      type: 'object',
      properties: {
        reservationId: {
          type: 'string',
          description: 'The reservation ID to check in to. If not provided, will check in to the next eligible reservation.',
        },
      },
      required: [],
    },
  },
  {
    name: 'check_out',
    description: 'Check out from a reservation early',
    inputSchema: {
      type: 'object',
      properties: {
        reservationId: {
          type: 'string',
          description: 'The reservation ID to check out from',
        },
      },
      required: ['reservationId'],
    },
  },
  {
    name: 'search_resources',
    description: 'Search for available desks or conference rooms',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['desk', 'room', 'all'],
          description: 'Type of resource to search for. Defaults to all.',
        },
        search: {
          type: 'string',
          description: 'Search query (name, location, etc.)',
        },
        location: {
          type: 'string',
          description: 'Filter by location path (e.g., building, floor)',
        },
        date: {
          type: 'string',
          description: 'Date to check availability (YYYY-MM-DD)',
        },
        startTime: {
          type: 'string',
          description: 'Start time for availability check (HH:MM)',
        },
        endTime: {
          type: 'string',
          description: 'End time for availability check (HH:MM)',
        },
        capacity: {
          type: 'number',
          description: 'Minimum capacity (for conference rooms)',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_resource_info',
    description: 'Get detailed information about a specific desk or room',
    inputSchema: {
      type: 'object',
      properties: {
        resource: {
          type: 'string',
          description: 'Resource name or ID',
        },
      },
      required: ['resource'],
    },
  },
  {
    name: 'reserve_desk_day',
    description: 'Reserve a desk for a full work day (9am-5pm). Simple command that just needs desk name and date.',
    inputSchema: {
      type: 'object',
      properties: {
        desk: {
          type: 'string',
          description: 'Desk name (e.g., "08W-125-H") or resource ID',
        },
        date: {
          type: 'string',
          description: 'Date for the reservation (YYYY-MM-DD format). Use "today", "tomorrow", or a specific date.',
        },
      },
      required: ['desk', 'date'],
    },
  },
  {
    name: 'reserve_desk_recurring',
    description: 'Automatically reserve a desk for all upcoming weekdays (9am-5pm). Just provide the desk name and it will book Monday-Friday for the next 7 days. Run this weekly to keep your desk reserved.',
    inputSchema: {
      type: 'object',
      properties: {
        desk: {
          type: 'string',
          description: 'Desk name (e.g., "08W-125-H") or resource ID',
        },
        days: {
          type: 'array',
          items: { type: 'string' },
          description: 'Which days to book each week. Defaults to all weekdays: ["monday", "tuesday", "wednesday", "thursday", "friday"]',
        },
      },
      required: ['desk'],
    },
  },
  {
    name: 'check_meeting_availability',
    description: 'Check availability of conference rooms and huddle rooms for a meeting. Excludes desks from results. If no floor is specified, automatically detects the floor from the user\'s desk reservation for that day. Accepts either duration (in minutes) or end time.',
    inputSchema: {
      type: 'object',
      properties: {
        floor: {
          type: 'string',
          description: 'Floor shortcut (e.g., "8", "8W", "8E"). If not provided, auto-detects from user\'s desk reservation for the day.',
        },
        date: {
          type: 'string',
          description: 'Date to check (YYYY-MM-DD, "today", "tomorrow"). Defaults to today.',
        },
        startTime: {
          type: 'string',
          description: 'Start time (HH:MM format, 24-hour). Required.',
        },
        duration: {
          type: 'number',
          description: 'Meeting duration in minutes (e.g., 30, 60, 90). Use this OR endTime.',
        },
        endTime: {
          type: 'string',
          description: 'End time (HH:MM format, 24-hour). Use this OR duration.',
        },
        resources: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of specific resource names or IDs to check (e.g., ["08W-120", "08W-122"])',
        },
        location: {
          type: 'string',
          description: 'Optional: Full location prefix to match (e.g., "!CR NYNY 7 HUDSON 08W")',
        },
        skipMap: {
          type: 'boolean',
          description: 'Skip generating the floor map image. Useful for quick availability checks or batch queries.',
        },
      },
      required: ['startTime'],
    },
  },
  {
    name: 'batch_check_availability',
    description: 'Check meeting room availability across multiple days and times in a single call. Returns a summary table showing availability patterns. Useful for finding the best time slots across a week.',
    inputSchema: {
      type: 'object',
      properties: {
        floor: {
          type: 'string',
          description: 'Floor shortcut (e.g., "8", "8W", "8E"). If not provided, auto-detects from user\'s desk reservation.',
        },
        dates: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of dates to check (YYYY-MM-DD format). Defaults to next 5 weekdays.',
        },
        times: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of start times to check (HH:MM format, 24-hour). Defaults to hourly from 9am-5pm.',
        },
        duration: {
          type: 'number',
          description: 'Meeting duration in minutes. Defaults to 30.',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_availability_stats',
    description: 'Generate visual text-based charts showing meeting room availability patterns for the week. Shows heatmaps, bar charts, and recommendations. Excludes Fridays by default since fewer people come in.',
    inputSchema: {
      type: 'object',
      properties: {
        floor: {
          type: 'string',
          description: 'Floor shortcut (e.g., "8", "8W", "8E"). If not provided, auto-detects from user\'s desk reservation.',
        },
        duration: {
          type: 'number',
          description: 'Meeting duration in minutes. Defaults to 30.',
        },
        includeFriday: {
          type: 'boolean',
          description: 'Include Friday in the stats. Defaults to false.',
        },
      },
      required: [],
    },
  },
];

// Tool handlers
async function handleReserveDesk(args: {
  desk: string;
  date: string;
  startTime?: string;
  endTime?: string;
  subject?: string;
}): Promise<string> {
  const resourceId = await resolveResourceId(args.desk, deskLookup, client);
  if (!resourceId) {
    return `Error: Could not find desk "${args.desk}". Please check the name or use a valid resource ID.`;
  }

  const startTime = args.startTime || config.defaultStartTime;
  const endTime = args.endTime || config.defaultEndTime;
  
  const { startAt, endAt } = getFullDayRange(args.date, startTime, endTime, config.timezone);

  const result = await client.createReservation({
    resourceIds: [resourceId],
    startAt,
    endAt,
    subject: args.subject || 'Desk Reservation',
    timezone: config.timezone,
  });

  if (!result.success) {
    return `Error creating reservation: ${result.error}`;
  }

  return `✅ Desk reserved successfully!\n\n` +
    `**Desk:** ${args.desk}\n` +
    `**Date:** ${args.date}\n` +
    `**Time:** ${startTime} - ${endTime}\n` +
    `**Reservation ID:** ${result.data?.id}`;
}

async function handleReserveRoom(args: {
  room: string;
  date: string;
  startTime: string;
  endTime: string;
  subject?: string;
}): Promise<string> {
  const resourceId = await resolveResourceId(args.room, deskLookup, client);
  if (!resourceId) {
    return `Error: Could not find room "${args.room}". Please check the name or use a valid resource ID.`;
  }

  const { startAt, endAt } = getFullDayRange(args.date, args.startTime, args.endTime, config.timezone);

  const result = await client.createReservation({
    resourceIds: [resourceId],
    startAt,
    endAt,
    subject: args.subject || 'Meeting',
    timezone: config.timezone,
  });

  if (!result.success) {
    return `Error creating reservation: ${result.error}`;
  }

  return `✅ Room reserved successfully!\n\n` +
    `**Room:** ${args.room}\n` +
    `**Date:** ${args.date}\n` +
    `**Time:** ${args.startTime} - ${args.endTime}\n` +
    `**Subject:** ${args.subject || 'Meeting'}\n` +
    `**Reservation ID:** ${result.data?.id}`;
}

async function handleCancelReservation(args: { reservationId: string }): Promise<string> {
  const result = await client.cancelReservation(args.reservationId);

  if (!result.success) {
    return `Error canceling reservation: ${result.error}`;
  }

  return `✅ Reservation ${args.reservationId} has been canceled.`;
}

async function handleModifyReservation(args: {
  reservationId: string;
  date?: string;
  startTime?: string;
  endTime?: string;
  resource?: string;
  subject?: string;
}): Promise<string> {
  const updates: Parameters<typeof client.updateReservation>[1] = {};

  if (args.date || args.startTime || args.endTime) {
    // Get current reservation to fill in missing time info
    const current = await client.getReservation(args.reservationId);
    if (!current.success || !current.data) {
      return `Error: Could not fetch reservation ${args.reservationId}`;
    }

    const currentStart = new Date(current.data.startAt);
    const currentEnd = new Date(current.data.endAt);

    const date = args.date || currentStart.toISOString().split('T')[0];
    const startTime = args.startTime || `${currentStart.getHours().toString().padStart(2, '0')}:${currentStart.getMinutes().toString().padStart(2, '0')}`;
    const endTime = args.endTime || `${currentEnd.getHours().toString().padStart(2, '0')}:${currentEnd.getMinutes().toString().padStart(2, '0')}`;

    const { startAt, endAt } = getFullDayRange(date, startTime, endTime, config.timezone);
    updates.startAt = startAt;
    updates.endAt = endAt;
  }

  if (args.resource) {
    const resourceId = await resolveResourceId(args.resource, deskLookup, client);
    if (!resourceId) {
      return `Error: Could not find resource "${args.resource}"`;
    }
    updates.resourceIds = [resourceId];
  }

  if (args.subject) {
    updates.subject = args.subject;
  }

  const result = await client.updateReservation(args.reservationId, updates);

  if (!result.success) {
    return `Error modifying reservation: ${result.error}`;
  }

  return `✅ Reservation ${args.reservationId} has been updated.`;
}

async function handleListReservations(args: {
  startDate?: string;
  endDate?: string;
  status?: string;
}): Promise<string> {
  const today = new Date();
  const startDate = args.startDate || today.toISOString().split('T')[0];
  
  const endDateObj = args.endDate 
    ? new Date(args.endDate) 
    : new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);
  const endDate = endDateObj.toISOString().split('T')[0];

  const result = await client.getMyReservations({
    startAt: `${startDate}T00:00:00.000Z`,
    endAt: `${endDate}T23:59:59.999Z`,
  });

  if (!result.success) {
    return `Error fetching reservations: ${result.error}`;
  }

  const reservations = result.data?.items || [];

  if (reservations.length === 0) {
    return `No reservations found between ${startDate} and ${endDate}.`;
  }

  let output = `📅 **Your Reservations** (${startDate} to ${endDate})\n\n`;

  for (const res of reservations) {
    const start = new Date(res.startAt);
    const end = new Date(res.endAt);
    const dateStr = start.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const timeStr = `${start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} - ${end.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;

    output += `**${dateStr}** ${timeStr}\n`;
    output += `  Status: ${res.status}\n`;
    output += `  ID: \`${res.id}\`\n\n`;
  }

  return output;
}

async function handleCheckIn(args: { reservationId?: string }): Promise<string> {
  if (args.reservationId) {
    // Check in to specific reservation
    const reservation = await client.getReservation(args.reservationId);
    if (!reservation.success || !reservation.data) {
      return `Error: Could not find reservation ${args.reservationId}`;
    }

    const result = await client.checkIn(args.reservationId, reservation.data.resourceIds);
    if (!result.success) {
      return `Error checking in: ${result.error}`;
    }

    return `✅ Successfully checked in to reservation ${args.reservationId}`;
  }

  // Find next eligible reservation to check in
  const now = new Date();
  const windowStart = new Date(now.getTime() - 15 * 60 * 1000);
  const windowEnd = new Date(now.getTime() + 15 * 60 * 1000);

  const reservations = await client.getMyReservations({
    startAt: windowStart.toISOString(),
    endAt: windowEnd.toISOString(),
    status: 'NotConfirmed,Pending,Checkin',
  });

  if (!reservations.success || !reservations.data?.items.length) {
    return `No reservations found that are eligible for check-in right now. You can check in 15 minutes before or after the start time.`;
  }

  // Check in to the first eligible one
  const res = reservations.data.items[0];
  const result = await client.checkIn(res.id, res.resourceIds);

  if (!result.success) {
    return `Error checking in: ${result.error}`;
  }

  return `✅ Successfully checked in to reservation ${res.id}`;
}

async function handleCheckOut(args: { reservationId: string }): Promise<string> {
  const result = await client.checkOut(args.reservationId);

  if (!result.success) {
    return `Error checking out: ${result.error}`;
  }

  return `✅ Successfully checked out from reservation ${args.reservationId}`;
}

async function handleSearchResources(args: {
  type?: 'desk' | 'room' | 'all';
  search?: string;
  location?: string;
  date?: string;
  startTime?: string;
  endTime?: string;
  capacity?: number;
}): Promise<string> {
  // Detect if location is a UUID (location ID) or a path string
  const isUuid = args.location && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.location);
  
  const result = await client.searchResources({
    type: args.type as 'desk' | 'room' | 'all' | undefined,
    search: args.search,
    locationPath: isUuid ? undefined : args.location,
    locationId: isUuid ? args.location : undefined,
    capacity: args.capacity,
    limit: 25,
  });

  if (!result.success) {
    return `Error searching resources: ${result.error}`;
  }

  const resources = result.data?.items || [];

  if (resources.length === 0) {
    return `No resources found matching your criteria.`;
  }

  let output = `🔍 **Search Results** (${resources.length} found)\n\n`;

  for (const res of resources.slice(0, 25)) {
    output += `**${res.name}**\n`;
    output += `  Type: ${res.type}\n`;
    if (res.locationPath) output += `  Location: ${res.locationPath}\n`;
    if (res.capacity) output += `  Capacity: ${res.capacity}\n`;
    output += `  ID: \`${res.id}\`\n\n`;
  }

  if (resources.length > 25) {
    output += `\n_...and ${resources.length - 25} more results_`;
  }

  return output;
}

async function handleGetResourceInfo(args: { resource: string }): Promise<string> {
  const resourceId = await resolveResourceId(args.resource, deskLookup, client);
  
  if (!resourceId) {
    return `Error: Could not find resource "${args.resource}"`;
  }

  const result = await client.getResource(resourceId);

  if (!result.success || !result.data) {
    return `Error fetching resource info: ${result.error}`;
  }

  const res = result.data;
  let output = `📍 **${res.name}**\n\n`;
  output += `**Type:** ${res.type}\n`;
  output += `**ID:** \`${res.id}\`\n`;
  if (res.locationPath) output += `**Location:** ${res.locationPath}\n`;
  if (res.capacity) output += `**Capacity:** ${res.capacity}\n`;
  if (res.amenities?.length) output += `**Amenities:** ${res.amenities.join(', ')}\n`;

  return output;
}

/**
 * Parse a date string that could be "today", "tomorrow", or YYYY-MM-DD
 */
function parseDate(dateStr: string): string {
  const lower = dateStr.toLowerCase().trim();
  const today = new Date();
  
  if (lower === 'today') {
    return today.toISOString().split('T')[0];
  }
  
  if (lower === 'tomorrow') {
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow.toISOString().split('T')[0];
  }
  
  // Check for relative dates like "next monday"
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const nextMatch = lower.match(/^next\s+(\w+)$/);
  if (nextMatch) {
    const dayName = nextMatch[1];
    const targetDay = dayNames.indexOf(dayName);
    if (targetDay !== -1) {
      const currentDay = today.getDay();
      let daysUntil = targetDay - currentDay;
      if (daysUntil <= 0) daysUntil += 7;
      const target = new Date(today);
      target.setDate(target.getDate() + daysUntil);
      return target.toISOString().split('T')[0];
    }
  }
  
  // Assume it's already YYYY-MM-DD
  return dateStr;
}

/**
 * Get day of week (0 = Sunday, 6 = Saturday)
 */
function getDayOfWeek(dateStr: string): number {
  return new Date(dateStr).getDay();
}

/**
 * Check if a day is a weekday
 */
function isWeekday(dateStr: string): boolean {
  const day = getDayOfWeek(dateStr);
  return day >= 1 && day <= 5;
}

async function handleReserveDeskDay(args: {
  desk: string;
  date: string;
}): Promise<string> {
  const resourceId = await resolveResourceId(args.desk, deskLookup, client);
  if (!resourceId) {
    return `Error: Could not find desk "${args.desk}". Please check the name or use a valid resource ID.`;
  }

  const date = parseDate(args.date);
  const { startAt, endAt } = getFullDayRange(date, config.defaultStartTime, config.defaultEndTime, config.timezone);

  const result = await client.createReservation({
    resourceIds: [resourceId],
    startAt,
    endAt,
    subject: 'Desk Reservation',
    timezone: config.timezone,
  });

  if (!result.success) {
    return `Error creating reservation: ${result.error}`;
  }

  const dayName = new Date(date).toLocaleDateString('en-US', { weekday: 'long' });

  return `✅ Desk reserved for full day!\n\n` +
    `**Desk:** ${args.desk}\n` +
    `**Date:** ${dayName}, ${date}\n` +
    `**Time:** ${config.defaultStartTime} - ${config.defaultEndTime}\n` +
    `**Reservation ID:** ${result.data?.id}`;
}

async function handleReserveDeskRecurring(args: {
  desk: string;
  days?: string[];
}): Promise<string> {
  const resourceId = await resolveResourceId(args.desk, deskLookup, client);
  if (!resourceId) {
    return `Error: Could not find desk "${args.desk}". Please check the name or use a valid resource ID.`;
  }

  // Default to all weekdays
  const dayNameToNum: Record<string, number> = {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
    thursday: 4, friday: 5, saturday: 6,
    sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
  };

  const daysToBook = args.days?.map(d => dayNameToNum[d.toLowerCase()]).filter(d => d !== undefined) 
    ?? [1, 2, 3, 4, 5]; // Mon-Fri by default

  // Book from today through the next 7 days
  const today = new Date();
  const datesToBook: string[] = [];

  for (let i = 0; i <= 7; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() + i);
    const dayOfWeek = date.getDay();

    if (daysToBook.includes(dayOfWeek)) {
      datesToBook.push(date.toISOString().split('T')[0]);
    }
  }

  if (datesToBook.length === 0) {
    return `No matching days found in the next 7 days.`;
  }

  // Book each date
  const results: { date: string; success: boolean; id?: string; error?: string }[] = [];

  for (const date of datesToBook) {
    const { startAt, endAt } = getFullDayRange(date, config.defaultStartTime, config.defaultEndTime, config.timezone);

    const result = await client.createReservation({
      resourceIds: [resourceId],
      startAt,
      endAt,
      subject: 'Desk Reservation',
      timezone: config.timezone,
    });

    if (result.success) {
      results.push({ date, success: true, id: result.data?.id });
    } else {
      // Check if it's just "already booked" vs a real error
      const errorStr = result.error || '';
      const alreadyBooked = errorStr.toLowerCase().includes('conflict') || 
                           errorStr.toLowerCase().includes('already') ||
                           errorStr.toLowerCase().includes('overlap');
      results.push({ 
        date, 
        success: false, 
        error: alreadyBooked ? 'Already booked' : result.error 
      });
    }

    // Small delay between requests to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Format output
  const successful = results.filter(r => r.success);
  const alreadyBooked = results.filter(r => !r.success && r.error === 'Already booked');
  const failed = results.filter(r => !r.success && r.error !== 'Already booked');

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const bookedDays = daysToBook.map(d => dayNames[d]).join(', ');

  let output = `🔄 **Weekly Desk Reservation**\n\n`;
  output += `**Desk:** ${args.desk}\n`;
  output += `**Schedule:** ${bookedDays}, ${config.defaultStartTime} - ${config.defaultEndTime}\n\n`;

  if (successful.length > 0) {
    output += `✅ **Newly booked (${successful.length}):**\n`;
    for (const r of successful) {
      const d = new Date(r.date);
      const dayName = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      output += `  • ${dayName}\n`;
    }
  }

  if (alreadyBooked.length > 0) {
    output += `\n📌 **Already reserved (${alreadyBooked.length}):**\n`;
    for (const r of alreadyBooked) {
      const d = new Date(r.date);
      const dayName = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      output += `  • ${dayName}\n`;
    }
  }

  if (failed.length > 0) {
    output += `\n❌ **Failed (${failed.length}):**\n`;
    for (const r of failed) {
      const d = new Date(r.date);
      const dayName = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      output += `  • ${dayName}: ${r.error}\n`;
    }
  }

  output += `\n💡 _Run this command weekly to keep your desk reserved._`;

  return output;
}

/**
 * Extract floor from a desk/room name (e.g., "08W-125-H" -> "8W", "!CR NYNY 7 HUDSON 08W-140" -> "8W")
 */
function extractFloorFromName(name: string): string | null {
  const match = name.match(/(\d{2})([EW])?-\d+/);
  if (match) {
    const floorNum = parseInt(match[1], 10).toString(); // "08" -> "8"
    const wing = match[2] || ''; // "W" or "E" or ""
    return floorNum + wing;
  }
  return null;
}

/**
 * Calculate end time from start time and duration in minutes
 */
function calculateEndTime(startTime: string, durationMinutes: number): string {
  const [hours, minutes] = startTime.split(':').map(Number);
  const totalMinutes = hours * 60 + minutes + durationMinutes;
  const endHours = Math.floor(totalMinutes / 60) % 24;
  const endMinutes = totalMinutes % 60;
  return `${endHours.toString().padStart(2, '0')}:${endMinutes.toString().padStart(2, '0')}`;
}

/**
 * Get the user's desk reservation for a specific date to determine their floor
 */
async function getUserFloorForDate(targetDate: string): Promise<{ floor: string; deskName: string } | null> {
  // Query reservations starting from the target date
  // The API with includesourceobject=true returns resources directly
  const result = await client.getMyReservations({
    startAt: `${targetDate}T00:00:00.000Z`,
  });

  if (!result.success || !result.data?.items.length) {
    return null;
  }

  // Find a desk reservation for the target date
  const targetDateStr = targetDate.split('T')[0]; // Ensure we have just the date part
  
  for (const reservation of result.data.items) {
    // Check if this reservation is for the target date
    const reservationDate = reservation.startAt.split('T')[0];
    if (reservationDate !== targetDateStr) continue;
    
    // Check the resources array
    if (reservation.resources && Array.isArray(reservation.resources)) {
      for (const resource of reservation.resources) {
        const resourceName = resource.resourceName;
        if (!resourceName) continue;
        
        // Skip conference rooms (they start with !CR)
        if (resourceName.startsWith('!CR') || resourceName.startsWith('!')) continue;
        
        // Check if it's a desk by subType
        if (resource.resourceSubType === 'Desk') {
          const floor = extractFloorFromName(resourceName);
          if (floor) {
            return { floor, deskName: resourceName };
          }
        }
      }
    }
  }

  return null;
}

// ============================================================================
// DYNAMIC FLOOR DATA - Fetched from Appspace GeoJSON API
// ============================================================================

interface RoomCoords {
  x1: number; y1: number; x2: number; y2: number;
  type: 'conf' | 'huddle';
  cx: number; cy: number;
  name: string;
  wing: 'E' | 'W' | null;
}

interface DeskCoords {
  cx: number; cy: number;
  name: string;
  wing: 'E' | 'W' | null;
}

interface FloorGeoData {
  rooms: Record<string, RoomCoords>;
  desks: Record<string, DeskCoords>;
  svgWidth: number;
  svgHeight: number;
  fetchedAt: number;
}

// Cache for floor GeoJSON data (keyed by floorId)
const floorGeoDataCache: Record<string, FloorGeoData> = {};

/**
 * Fetch and parse GeoJSON data for a floor from Appspace API
 */
async function fetchFloorGeoData(
  floorId: string,
  layerSettingId: string,
  token: string,
  host: string
): Promise<FloorGeoData | null> {
  // Check cache (valid for 1 hour)
  const cached = floorGeoDataCache[floorId];
  if (cached && Date.now() - cached.fetchedAt < 3600000) {
    return cached;
  }

  try {
    const rooms: Record<string, RoomCoords> = {};
    const desks: Record<string, DeskCoords> = {};
    let page = 1;
    let hasMore = true;

    // Fetch all pages of GeoJSON data
    while (hasMore && page <= 10) {
      const url = `https://${host}/api/v3/maps/floors/${floorId}/layers/settings/${layerSettingId}/nodes/settings?start=0&page=${page}&limit=250&pagecount=250`;
      
      const response = await fetch(url, {
        headers: {
          'accept': 'application/json',
          'token': token,
        },
      });

      if (!response.ok) break;
      
      const data = await response.json();
      if (!data.items || data.items.length === 0) break;

      for (const item of data.items) {
        const name = item.setting?.name;
        const subType = item.setting?.subType;
        const coords = item.geoJSON?.geometry?.coordinates?.[0];
        
        if (!name || !coords || coords.length === 0) continue;

        // Extract bounding box from polygon coordinates
        const xs = coords.flat().filter((_: number, i: number) => i % 2 === 0);
        const ys = coords.flat().filter((_: number, i: number) => i % 2 === 1);
        const x1 = Math.min(...xs);
        const y1 = Math.min(...ys);
        const x2 = Math.max(...xs);
        const y2 = Math.max(...ys);
        const cx = (x1 + x2) / 2;
        const cy = (y1 + y2) / 2;

        // Determine wing from name (e.g., "08W-134" -> "W")
        const wingMatch = name.match(/\d{2}([EW])-/);
        const wing = wingMatch ? wingMatch[1] as 'E' | 'W' : null;

        // Extract room number (e.g., "08W-134" -> "134")
        const roomNumMatch = name.match(/\d{2}[EW]?-(\d+)(?:-[A-Z])?$/);
        const roomNum = roomNumMatch ? roomNumMatch[1] : null;

        if (subType === 'VideoConferenceRoom' || subType === 'HuddleSpace') {
          // It's a room - skip individual desk entries (those with -A, -B, etc.)
          if (name.match(/-[A-Z]$/)) continue;
          
          const isConf = subType === 'VideoConferenceRoom';
          if (roomNum) {
            rooms[roomNum] = {
              x1, y1, x2, y2, cx, cy,
              type: isConf ? 'conf' : 'huddle',
              name: roomNum,
              wing,
            };
          }
        } else if (subType === 'Desk') {
          // It's a desk
          desks[name] = { cx, cy, name, wing };
        }
      }

      hasMore = data.items.length === 250;
      page++;
    }

    const geoData: FloorGeoData = {
      rooms,
      desks,
      svgWidth: 721, // Standard floor width
      svgHeight: 385, // Standard floor height
      fetchedAt: Date.now(),
    };

    floorGeoDataCache[floorId] = geoData;
    return geoData;

  } catch (error) {
    console.error(`Failed to fetch floor geo data: ${error}`);
    return null;
  }
}

// Get user desk coordinates from cached floor data or static fallback
function getUserDeskCoords(deskName: string | null, floorGeoData?: FloorGeoData | null): { cx: number; cy: number } | null {
  if (!deskName) return null;
  
  // Try dynamic data first
  if (floorGeoData?.desks[deskName]) {
    const desk = floorGeoData.desks[deskName];
    return { cx: desk.cx, cy: desk.cy };
  }
  
  // Static fallback for Floor 08W (commonly used)
  const FLOOR_08W_DESKS: Record<string, { cx: number; cy: number }> = {
    '08W-119-A': { cx: 48, cy: 243 }, '08W-119-B': { cx: 38, cy: 243 }, '08W-119-C': { cx: 28, cy: 243 },
    '08W-119-D': { cx: 18, cy: 243 }, '08W-119-E': { cx: 8, cy: 243 },
    '08W-119-F': { cx: 48, cy: 249 }, '08W-119-G': { cx: 38, cy: 249 }, '08W-119-H': { cx: 28, cy: 249 },
    '08W-121-A': { cx: 52, cy: 266 }, '08W-121-C': { cx: 34, cy: 271 }, '08W-121-D': { cx: 26, cy: 266 },
    '08W-123-A': { cx: 53, cy: 296 }, '08W-123-B': { cx: 42, cy: 296 }, '08W-123-C': { cx: 32, cy: 296 },
    '08W-123-D': { cx: 22, cy: 296 }, '08W-123-E': { cx: 12, cy: 296 },
    '08W-123-F': { cx: 53, cy: 301 }, '08W-123-G': { cx: 42, cy: 301 }, '08W-123-H': { cx: 32, cy: 301 },
    '08W-125-A': { cx: 53, cy: 318 }, '08W-125-B': { cx: 42, cy: 318 }, '08W-125-C': { cx: 32, cy: 318 },
    '08W-125-D': { cx: 22, cy: 318 }, '08W-125-E': { cx: 12, cy: 318 },
    '08W-125-F': { cx: 53, cy: 324 }, '08W-125-G': { cx: 42, cy: 324 }, '08W-125-H': { cx: 32, cy: 324 },
    '08W-125-J': { cx: 22, cy: 324 }, '08W-125-K': { cx: 12, cy: 324 },
    '08W-127-A': { cx: 53, cy: 340 }, '08W-127-B': { cx: 42, cy: 340 }, '08W-127-C': { cx: 32, cy: 340 },
    '08W-127-D': { cx: 22, cy: 340 }, '08W-127-E': { cx: 12, cy: 340 },
    '08W-127-F': { cx: 53, cy: 346 }, '08W-127-G': { cx: 42, cy: 346 }, '08W-127-H': { cx: 32, cy: 346 },
  };
  
  // Static fallback for Floor 08E (East wing) - sample desks
  const FLOOR_08E_DESKS: Record<string, { cx: number; cy: number }> = {
    // Sample East wing desk coordinates (based on GeoJSON data: x: 399-708, y: 11-374)
    '08E-301-A': { cx: 420, cy: 150 }, '08E-301-B': { cx: 430, cy: 150 }, '08E-301-C': { cx: 440, cy: 150 },
    '08E-303-A': { cx: 420, cy: 180 }, '08E-303-B': { cx: 430, cy: 180 }, '08E-303-C': { cx: 440, cy: 180 },
    '08E-305-A': { cx: 420, cy: 210 }, '08E-305-B': { cx: 430, cy: 210 }, '08E-305-C': { cx: 440, cy: 210 },
    '08E-307-A': { cx: 510, cy: 150 }, '08E-307-B': { cx: 520, cy: 150 }, '08E-307-C': { cx: 530, cy: 150 },
    '08E-309-A': { cx: 510, cy: 180 }, '08E-309-B': { cx: 520, cy: 180 }, '08E-309-C': { cx: 530, cy: 180 },
    '08E-311-A': { cx: 510, cy: 210 }, '08E-311-B': { cx: 520, cy: 210 }, '08E-311-C': { cx: 530, cy: 210 },
    '08E-313-A': { cx: 600, cy: 150 }, '08E-313-B': { cx: 610, cy: 150 }, '08E-313-C': { cx: 620, cy: 150 },
    '08E-315-A': { cx: 600, cy: 180 }, '08E-315-B': { cx: 610, cy: 180 }, '08E-315-C': { cx: 620, cy: 180 },
    '08E-317-A': { cx: 670, cy: 200 }, '08E-317-B': { cx: 680, cy: 200 }, '08E-317-C': { cx: 690, cy: 200 },
    '08E-319-A': { cx: 670, cy: 230 }, '08E-319-B': { cx: 680, cy: 230 }, '08E-319-C': { cx: 690, cy: 230 },
  };
  
  return FLOOR_08W_DESKS[deskName] || FLOOR_08E_DESKS[deskName] || null;
}

// Static fallback room data for Floor 08W
const FLOOR_08W_ROOMS: Record<string, RoomCoords> = {
  '458': { x1: 71, y1: 68, x2: 94, y2: 85, type: 'huddle', cx: 82, cy: 76, name: '458', wing: 'W' },
  '460': { x1: 71, y1: 86, x2: 94, y2: 102, type: 'huddle', cx: 82, cy: 93, name: '460', wing: 'W' },
  '464': { x1: 71, y1: 127, x2: 93, y2: 143, type: 'huddle', cx: 82, cy: 135, name: '464', wing: 'W' },
  '466': { x1: 71, y1: 144, x2: 93, y2: 160, type: 'huddle', cx: 82, cy: 151, name: '466', wing: 'W' },
  '182': { x1: 236, y1: 152, x2: 259, y2: 169, type: 'huddle', cx: 247, cy: 160, name: '182', wing: 'W' },
  '180': { x1: 236, y1: 169, x2: 259, y2: 185, type: 'huddle', cx: 247, cy: 176, name: '180', wing: 'W' },
  '416': { x1: 327, y1: 149, x2: 344, y2: 172, type: 'huddle', cx: 335, cy: 160, name: '416', wing: 'W' },
  '414': { x1: 344, y1: 149, x2: 361, y2: 172, type: 'huddle', cx: 352, cy: 160, name: '414', wing: 'W' },
  '168': { x1: 236, y1: 229, x2: 259, y2: 245, type: 'huddle', cx: 247, cy: 236, name: '168', wing: 'W' },
  '166': { x1: 236, y1: 246, x2: 259, y2: 262, type: 'huddle', cx: 247, cy: 253, name: '166', wing: 'W' },
  '164': { x1: 237, y1: 262, x2: 259, y2: 279, type: 'huddle', cx: 247, cy: 270, name: '164', wing: 'W' },
  '172': { x1: 333, y1: 225, x2: 349, y2: 248, type: 'huddle', cx: 340, cy: 236, name: '172', wing: 'W' },
  '174': { x1: 350, y1: 225, x2: 365, y2: 248, type: 'huddle', cx: 357, cy: 236, name: '174', wing: 'W' },
  '134': { x1: 94, y1: 262, x2: 116, y2: 296, type: 'conf', cx: 105, cy: 279, name: '134', wing: 'W' },
  '136': { x1: 117, y1: 262, x2: 139, y2: 296, type: 'conf', cx: 127, cy: 279, name: '136', wing: 'W' },
  '138': { x1: 139, y1: 262, x2: 161, y2: 296, type: 'conf', cx: 149, cy: 279, name: '138', wing: 'W' },
  '140': { x1: 161, y1: 262, x2: 191, y2: 296, type: 'conf', cx: 176, cy: 279, name: '140', wing: 'W' },
  '142': { x1: 192, y1: 262, x2: 214, y2: 296, type: 'conf', cx: 202, cy: 279, name: '142', wing: 'W' },
  '144': { x1: 215, y1: 262, x2: 237, y2: 296, type: 'conf', cx: 225, cy: 279, name: '144', wing: 'W' },
};

// Static fallback room data for Floor 08E (East wing)
const FLOOR_08E_ROOMS: Record<string, RoomCoords> = {
  // Conference rooms (top row)
  '346': { x1: 485, y1: 91, x2: 507, y2: 125, type: 'conf', cx: 496, cy: 108, name: '346', wing: 'E' },
  '344': { x1: 508, y1: 91, x2: 529, y2: 125, type: 'conf', cx: 518, cy: 108, name: '344', wing: 'E' },
  '342': { x1: 530, y1: 91, x2: 551, y2: 125, type: 'conf', cx: 540, cy: 108, name: '342', wing: 'E' },
  '340': { x1: 552, y1: 91, x2: 583, y2: 125, type: 'conf', cx: 567, cy: 108, name: '340', wing: 'E' },
  '336': { x1: 584, y1: 91, x2: 606, y2: 125, type: 'conf', cx: 595, cy: 108, name: '336', wing: 'E' },
  '334': { x1: 606, y1: 91, x2: 627, y2: 125, type: 'conf', cx: 616, cy: 108, name: '334', wing: 'E' },
  // Huddle spaces (left column)
  '368': { x1: 462, y1: 125, x2: 485, y2: 141, type: 'huddle', cx: 473, cy: 133, name: '368', wing: 'E' },
  '370': { x1: 462, y1: 142, x2: 485, y2: 158, type: 'huddle', cx: 473, cy: 150, name: '370', wing: 'E' },
  '208': { x1: 462, y1: 202, x2: 486, y2: 218, type: 'huddle', cx: 474, cy: 210, name: '208', wing: 'E' },
  '210': { x1: 462, y1: 218, x2: 486, y2: 234, type: 'huddle', cx: 474, cy: 226, name: '210', wing: 'E' },
  '212': { x1: 462, y1: 235, x2: 486, y2: 251, type: 'huddle', cx: 474, cy: 243, name: '212', wing: 'E' },
  '214': { x1: 462, y1: 252, x2: 486, y2: 269, type: 'huddle', cx: 474, cy: 260, name: '214', wing: 'E' },
  // Huddle spaces (right column)
  '320': { x1: 628, y1: 108, x2: 651, y2: 125, type: 'huddle', cx: 639, cy: 116, name: '320', wing: 'E' },
  '318': { x1: 628, y1: 125, x2: 651, y2: 141, type: 'huddle', cx: 639, cy: 133, name: '318', wing: 'E' },
  '316': { x1: 628, y1: 142, x2: 651, y2: 158, type: 'huddle', cx: 639, cy: 150, name: '316', wing: 'E' },
  '254': { x1: 628, y1: 227, x2: 650, y2: 243, type: 'huddle', cx: 639, cy: 235, name: '254', wing: 'E' },
  '252': { x1: 628, y1: 244, x2: 650, y2: 260, type: 'huddle', cx: 639, cy: 252, name: '252', wing: 'E' },
  '246': { x1: 628, y1: 300, x2: 651, y2: 317, type: 'huddle', cx: 639, cy: 308, name: '246', wing: 'E' },
  '244': { x1: 628, y1: 318, x2: 651, y2: 334, type: 'huddle', cx: 639, cy: 326, name: '244', wing: 'E' },
  // Center huddle
  '200': { x1: 421, y1: 225, x2: 437, y2: 248, type: 'huddle', cx: 429, cy: 236, name: '200', wing: 'E' },
};

/**
 * Generate a spatially accurate ASCII floor map using actual GeoJSON coordinates.
 * Uses a grid-based approach where each character represents ~8 pixels.
 * 
 * Room coordinates from GeoJSON (verified):
 * - 458: x=71-94, y=68-85    - 460: x=71-94, y=86-102
 * - 464: x=71-93, y=127-143  - 466: x=71-93, y=144-160
 * - 416: x=327-344, y=149-172 - 414: x=344-361, y=149-172
 * - 182: x=236-259, y=152-169 - 180: x=236-259, y=169-185
 * - 172: x=333-349, y=225-248 - 174: x=350-365, y=225-248
 * - 168: x=236-259, y=229-245 - 166: x=236-259, y=246-262
 * - 134-144: x=94-237, y=262-296 (conference row)
 * - 164: x=237-259, y=262-279
 */
function generateTextFloorMap(options: {
  availableConf: string[];
  unavailableConf: string[];
  availableHuddle: string[];
  unavailableHuddle: string[];
  userDesk: string | null;
  wingFilter: string | null;
  baseFloor: string;
  floorGeoData?: FloorGeoData | null;
}): string {
  const { availableConf, unavailableConf, availableHuddle, unavailableHuddle, userDesk, wingFilter, baseFloor, floorGeoData } = options;
  
  // Determine wing first for fallback selection
  const detectedWing = userDesk?.match(/\d{2}([EW])-/)?.[1] || wingFilter || 'W';
  
  // Use dynamic geo data if available, otherwise fall back to static data for floor 08
  const getStaticRoomData = () => {
    if (baseFloor !== '08') return null;
    // Combine both wing data, filtering will happen later
    return { ...FLOOR_08W_ROOMS, ...FLOOR_08E_ROOMS };
  };
  const roomData = floorGeoData?.rooms || getStaticRoomData();
  
  // Only generate spatial map if we have room data and it's a supported floor/wing
  if (!roomData || Object.keys(roomData).length === 0) {
    return generateSimpleFloorMap(options);
  }
  
  const allAvailable = new Set([...availableConf, ...availableHuddle].map(r => r.replace(/^\d{2}[EW]-/, '')));
  const allUnavailable = new Set([...unavailableConf, ...unavailableHuddle].map(r => r.replace(/^\d{2}[EW]-/, '')));
  
  // Get user desk coordinates
  const userDeskCoords = getUserDeskCoords(userDesk, floorGeoData);
  const userDeskShort = userDesk?.replace(/^\d{2}[EW]-/, '') || '';
  const floorPrefix = userDesk?.match(/^(\d{2}[EW])-/)?.[1] || `${baseFloor}${wingFilter || ''}`;
  
  // Determine which wing to show - explicit wingFilter takes precedence over user's desk
  // This allows users to view a different wing than where their desk is located
  const userWing = wingFilter || userDesk?.match(/\d{2}([EW])-/)?.[1] || 'W';
  const wingLabel = userWing === 'W' ? 'WEST' : 'EAST';
  
  // Filter rooms to only show the relevant wing
  const wingRooms = Object.entries(roomData).filter(([_, room]) => {
    if (!room.wing) return true; // Include rooms without wing designation
    return room.wing === userWing;
  });
  
  // Helper to get room status symbol
  const getStatus = (room: string): string => {
    if (allAvailable.has(room)) return '✓';
    if (allUnavailable.has(room)) return '✗';
    return '·';
  };
  
  // Build grid-based ASCII map
  // Scale: 1 char = 4 pixels (doubled resolution for better detail)
  // West wing: 0-450px, East wing: 320-770px (expanded by 50px each direction)
  const SCALE = 4;
  const WIDTH = 113;   // 450 / 4 ≈ 113 chars (expanded by ~12 chars)
  const HEIGHT = 109;  // 435 / 4 ≈ 109 chars (expanded by ~12 chars)
  const xOffset = userWing === 'E' ? 320 : 0; // Shift for east wing
  
  // Initialize grid with spaces
  const grid: string[][] = Array.from({ length: HEIGHT }, () => Array(WIDTH).fill(' '));
  
  // Draw floor boundary
  for (let x = 0; x < WIDTH; x++) {
    grid[0][x] = '═';
    grid[HEIGHT - 1][x] = '═';
  }
  for (let y = 0; y < HEIGHT; y++) {
    grid[y][0] = '║';
    grid[y][WIDTH - 1] = '║';
  }
  grid[0][0] = '╔'; grid[0][WIDTH-1] = '╗';
  grid[HEIGHT-1][0] = '╚'; grid[HEIGHT-1][WIDTH-1] = '╝';
  
  // Track which grid cells belong to rooms (to prevent desk pod overlap)
  const roomCells = new Set<string>();
  
  // Helper to draw a room box with label (only show label for available rooms)
  const drawRoom = (room: RoomCoords, status: string, isAvailable: boolean) => {
    // GeoJSON rooms share exact edges (e.g., room A ends at x=139, room B starts at x=139)
    // We use floor() for start coordinates and floor(end - 1) for end coordinates
    // This ensures adjacent rooms don't overlap in the grid
    const cx1 = Math.floor((room.x1 - xOffset) / SCALE);
    const cy1 = Math.floor(room.y1 / SCALE);
    // Subtract 1 from end coordinates before dividing to prevent shared-edge overlap
    const cx2 = Math.floor((room.x2 - 1 - xOffset) / SCALE);
    const cy2 = Math.floor((room.y2 - 1) / SCALE);
    
    if (cx1 < 1 || cx2 >= WIDTH - 1 || cy1 < 1 || cy2 >= HEIGHT - 1) return;
    if (cx2 <= cx1 || cy2 <= cy1) return; // Skip if room is too small to render
    
    // Mark all cells in this room's bounding box as room cells (including interior)
    for (let y = cy1; y <= cy2; y++) {
      for (let x = cx1; x <= cx2; x++) {
        roomCells.add(`${y},${x}`);
      }
    }
    
    const isConf = room.type === 'conf';
    // Use dimmer characters for unavailable rooms
    const hChar = isConf ? (isAvailable ? '═' : '─') : '─';
    const vChar = isConf ? (isAvailable ? '║' : '│') : '│';
    const tl = isConf ? (isAvailable ? '╔' : '┌') : '┌';
    const tr = isConf ? (isAvailable ? '╗' : '┐') : '┐';
    const bl = isConf ? (isAvailable ? '╚' : '└') : '└';
    const br = isConf ? (isAvailable ? '╝' : '┘') : '┘';
    
    // Helper to check if a cell already has a box character (from another room)
    const isBoxChar = (c: string) => '─│┌┐└┘═║╔╗╚╝├┤┬┴┼'.includes(c);
    
    // Draw top edge - use intersection chars if overlapping another room
    if (!isBoxChar(grid[cy1][cx1])) grid[cy1][cx1] = tl;
    for (let x = cx1 + 1; x < cx2; x++) {
      if (!isBoxChar(grid[cy1][x]) || grid[cy1][x] === '│' || grid[cy1][x] === '║') {
        grid[cy1][x] = hChar;
      }
    }
    if (!isBoxChar(grid[cy1][cx2])) grid[cy1][cx2] = tr;
    
    // Draw side edges
    for (let y = cy1 + 1; y < cy2; y++) {
      if (!isBoxChar(grid[y][cx1]) || grid[y][cx1] === '─' || grid[y][cx1] === '═') {
        grid[y][cx1] = vChar;
      }
      if (!isBoxChar(grid[y][cx2]) || grid[y][cx2] === '─' || grid[y][cx2] === '═') {
        grid[y][cx2] = vChar;
      }
    }
    
    // Draw bottom edge
    if (!isBoxChar(grid[cy2][cx1])) grid[cy2][cx1] = bl;
    for (let x = cx1 + 1; x < cx2; x++) {
      if (!isBoxChar(grid[cy2][x]) || grid[cy2][x] === '│' || grid[cy2][x] === '║') {
        grid[cy2][x] = hChar;
      }
    }
    if (!isBoxChar(grid[cy2][cx2])) grid[cy2][cx2] = br;
    
    // Only draw room number and status for AVAILABLE rooms
    if (isAvailable) {
      const midY = Math.floor((cy1 + cy2) / 2);
      const midX = Math.floor((cx1 + cx2) / 2);
      const label = room.name.slice(-3); // Last 3 chars of room number
      
      // Place label if there's room
      if (cx2 - cx1 >= 3) {
        const startX = midX - 1;
        for (let i = 0; i < Math.min(3, label.length) && startX + i < cx2; i++) {
          if (startX + i > cx1) grid[midY][startX + i] = label[i];
        }
      }
      
      // Place status symbol (✓ for available)
      if (cy2 - cy1 >= 2 && midY + 1 < cy2) {
        grid[midY + 1][midX] = status;
      } else if (midX + 2 < cx2) {
        grid[midY][midX + 2] = status;
      }
    }
  };
  
  // Draw all rooms for this wing
  for (const [roomNum, room] of wingRooms) {
    const isAvailable = allAvailable.has(roomNum);
    drawRoom(room, getStatus(roomNum), isAvailable);
  }
  
  // Draw desk pod areas (shaded) - based on actual desk locations from GeoJSON
  // Desk pods are concentrated in specific regions, NOT spanning entire floor
  
  // Define desk pod regions per wing (based on actual desk coordinate analysis)
  const deskPodRegions = userWing === 'W' ? [
    // West wing: Main left corridor desk pods (pods 119, 121, 123, 125, 127)
    // Desks at x: 8-53, y: 243-346
    { x1: 5, y1: 240, x2: 70, y2: 360 },
  ] : [
    // East wing: Desks spread across x: 399-708, y: 11-374
    // Main desk areas are in open floor space between rooms
    { x1: 399, y1: 130, x2: 460, y2: 200 },  // Left corridor upper
    { x1: 399, y1: 270, x2: 460, y2: 380 },  // Left corridor lower  
    { x1: 490, y1: 130, x2: 625, y2: 380 },  // Center floor area
    { x1: 655, y1: 130, x2: 720, y2: 380 },  // Right corridor
  ];
  
  for (const region of deskPodRegions) {
    const gx1 = Math.floor((region.x1 - xOffset) / SCALE);
    const gy1 = Math.floor(region.y1 / SCALE);
    const gx2 = Math.ceil((region.x2 - xOffset) / SCALE);
    const gy2 = Math.ceil(region.y2 / SCALE);
    
    for (let y = Math.max(1, gy1); y < Math.min(HEIGHT - 1, gy2); y++) {
      for (let x = Math.max(1, gx1); x < Math.min(WIDTH - 1, gx2); x++) {
        // Only shade if this cell is empty and not part of any room
        if (grid[y][x] === ' ' && !roomCells.has(`${y},${x}`)) {
          grid[y][x] = '░';
        }
      }
    }
  }
  
  // Mark user's desk with a star and label (only if desk is on the displayed wing)
  const deskWing = userDesk?.match(/\d{2}([EW])-/)?.[1];
  const showDesk = userDeskCoords && userDesk && deskWing === userWing;
  
  if (showDesk) {
    const deskX = Math.floor((userDeskCoords.cx - xOffset) / SCALE);
    const deskY = Math.floor(userDeskCoords.cy / SCALE);
    if (deskX > 0 && deskX < WIDTH - 1 && deskY > 0 && deskY < HEIGHT - 1) {
      grid[deskY][deskX] = '★';
      
      // Add desk number label to the right of the star
      // Extract just the desk number (e.g., "125-H" from "08W-125-H")
      const deskNum = userDesk.replace(/^\d+[WE]-/, '');
      const label = deskNum;
      
      // Place label to the right of the star if there's room
      for (let i = 0; i < label.length && deskX + 2 + i < WIDTH - 1; i++) {
        if (grid[deskY][deskX + 2 + i] === ' ' || grid[deskY][deskX + 2 + i] === '░') {
          grid[deskY][deskX + 2 + i] = label[i];
        }
      }
    }
  }
  
  // Build output string with the preferred format
  let output = '\n### 🗺️ Floor ' + baseFloor + wingFilter + ' - Accurate ASCII Map\n\n```\n';
  output += `FLOOR ${baseFloor}${userWing} (${wingLabel.toLowerCase()} side)\n`;
  output += '═'.repeat(WIDTH) + '\n';
  
  // Output grid (no axis labels)
  for (let y = 0; y < HEIGHT; y++) {
    output += grid[y].join('') + '\n';
  }
  
  output += '═'.repeat(WIDTH) + '\n';
  output += '```\n\n';
  
  // Legend
  output += '**Legend:**\n';
  output += '- `╔═══╗` Conference Room · `┌───┐` Huddle Space · `░░░` Desk Pods\n';
  if (showDesk) {
    output += `- \`★\` Your Desk (${userDeskShort})\n`;
  }
  output += '- `✓` Available · `✗` Busy\n\n';
  
  // Distance-sorted room list
  if (userDeskCoords) {
    output += `**Rooms by Distance from ${userDeskShort}:**\n`;
    output += '| Room | Type | Status | ~Distance |\n';
    output += '|------|------|--------|----------|\n';
    
    interface RoomDist { room: string; type: string; isAvail: boolean; dist: number }
    const roomDists: RoomDist[] = [];
    
    for (const [roomNum, coords] of wingRooms) {
      if (!allAvailable.has(roomNum) && !allUnavailable.has(roomNum)) continue;
      
      const dist = Math.sqrt(
        Math.pow(coords.cx - userDeskCoords.cx, 2) + 
        Math.pow(coords.cy - userDeskCoords.cy, 2)
      );
      
      roomDists.push({
        room: roomNum,
        type: coords.type === 'conf' ? 'Conf' : 'Huddle',
        isAvail: allAvailable.has(roomNum),
        dist: Math.round(dist),
      });
    }
    
    roomDists.sort((a, b) => {
      if (a.isAvail !== b.isAvail) return a.isAvail ? -1 : 1;
      return a.dist - b.dist;
    });
    
    for (const r of roomDists.slice(0, 12)) {
      const status = r.isAvail ? '✅ Avail' : '❌ Busy';
      const distFt = Math.round(r.dist * 0.4); // Rough pixel-to-feet conversion
      output += `| ${r.room.padEnd(4)} | ${r.type.padEnd(6)} | ${status} | ~${distFt}ft |\n`;
    }
  }
  
  return output;
}

/**
 * Simple fallback floor map for floors without coordinate data
 */
function generateSimpleFloorMap(options: {
  availableConf: string[];
  unavailableConf: string[];
  availableHuddle: string[];
  unavailableHuddle: string[];
  userDesk: string | null;
  wingFilter: string | null;
  baseFloor: string;
}): string {
  const { availableConf, unavailableConf, availableHuddle, unavailableHuddle, userDesk, wingFilter, baseFloor } = options;
  
  const allRooms = [...availableConf, ...unavailableConf, ...availableHuddle, ...unavailableHuddle];
  if (allRooms.length === 0) return '';
  
  interface RoomData {
    name: string;
    num: number;
    wing: string;
    isHuddle: boolean;
    isAvailable: boolean;
  }
  
  const roomsData: RoomData[] = allRooms.map(name => {
    const wingMatch = name.match(/\d{2}([EW])/);
    const numMatch = name.match(/\d{2}[EW]?-(\d+)/);
    return {
      name,
      num: numMatch ? parseInt(numMatch[1], 10) : 0,
      wing: wingMatch ? wingMatch[1] : '',
      isHuddle: availableHuddle.includes(name) || unavailableHuddle.includes(name),
      isAvailable: availableConf.includes(name) || availableHuddle.includes(name),
    };
  });
  
  const westRooms = roomsData.filter(r => r.wing === 'W').sort((a, b) => a.num - b.num);
  const eastRooms = roomsData.filter(r => r.wing === 'E').sort((a, b) => a.num - b.num);
  const userNumMatch = userDesk?.match(/\d{2}[EW]?-(\d+)/);
  const userNum = userNumMatch ? parseInt(userNumMatch[1], 10) : 0;
  const userWing = userDesk?.match(/\d{2}([EW])/)?.[1] || '';
  
  let output = '\n### 🗺️ Floor Map\n\n```\n';
  
  const formatRoom = (r: RoomData, highlight: boolean): string => {
    const icon = r.isAvailable ? (r.isHuddle ? '🟢' : '🟩') : (r.isHuddle ? '🔴' : '🟥');
    const num = String(r.num).padStart(3, ' ');
    const marker = highlight ? '📍' : '  ';
    return `${marker}${icon}${num}`;
  };
  
  const showWest = !wingFilter || wingFilter === 'W';
  const showEast = !wingFilter || wingFilter === 'E';
  
  output += `  ┌${'─'.repeat(50)}┐\n`;
  output += `  │ Floor ${baseFloor}${wingFilter || ''} - Meeting Room Availability${' '.repeat(Math.max(0, 50 - 38 - (wingFilter ? 1 : 0)))}│\n`;
  output += `  ├${'─'.repeat(50)}┤\n`;
  output += `  │ 🟩 Conf (avail)  🟥 Conf (busy)  📍 Your desk   │\n`;
  output += `  │ 🟢 Huddle (avail) 🔴 Huddle (busy)               │\n`;
  output += `  ├${'─'.repeat(50)}┤\n`;
  
  const renderWing = (rooms: RoomData[], wingName: string): string => {
    if (rooms.length === 0) return '';
    let wingOutput = `  │ ${wingName} Wing:${' '.repeat(43 - wingName.length)}│\n`;
    const rowSize = 5;
    for (let i = 0; i < rooms.length; i += rowSize) {
      const row = rooms.slice(i, i + rowSize);
      const roomStrings = row.map(r => {
        const isUserNearby = userWing === r.wing && Math.abs(userNum - r.num) < 10;
        return formatRoom(r, isUserNearby && userDesk !== null);
      });
      const rowStr = roomStrings.join(' ');
      wingOutput += `  │  ${rowStr}${' '.repeat(Math.max(0, 47 - rowStr.length))}│\n`;
    }
    return wingOutput;
  };
  
  if (showWest && westRooms.length > 0) output += renderWing(westRooms, 'West');
  if (showWest && showEast && westRooms.length > 0 && eastRooms.length > 0) output += `  ├${'─'.repeat(50)}┤\n`;
  if (showEast && eastRooms.length > 0) output += renderWing(eastRooms, 'East');
  
  output += `  └${'─'.repeat(50)}┘\n`;
  output += '```\n';
  
  return output;
}

/**
 * Sort rooms by proximity to a reference room number
 * e.g., if user is at 08W-125, prefer 08W-120, 08W-122 over 08W-464
 */
function sortByProximity(rooms: string[], referenceDesk: string | null): string[] {
  if (!referenceDesk) return rooms.sort();
  
  // Extract wing and room number from reference desk (e.g., "08W-125-H" -> W, 125)
  const refWingMatch = referenceDesk.match(/\d{2}([EW])/);
  const refWing = refWingMatch ? refWingMatch[1] : null;
  const refNumMatch = referenceDesk.match(/\d{2}[EW]?-(\d+)/);
  const refNumber = refNumMatch ? parseInt(refNumMatch[1], 10) : 0;
  
  return rooms.sort((a, b) => {
    // Extract wing and number for each room
    const aWingMatch = a.match(/\d{2}([EW])/);
    const bWingMatch = b.match(/\d{2}([EW])/);
    const aWing = aWingMatch ? aWingMatch[1] : null;
    const bWing = bWingMatch ? bWingMatch[1] : null;
    
    const aNumMatch = a.match(/\d{2}[EW]?-(\d+)/);
    const bNumMatch = b.match(/\d{2}[EW]?-(\d+)/);
    const aNum = aNumMatch ? parseInt(aNumMatch[1], 10) : 0;
    const bNum = bNumMatch ? parseInt(bNumMatch[1], 10) : 0;
    
    // Prioritize same wing as user's desk
    const aSameWing = aWing === refWing ? 0 : 1;
    const bSameWing = bWing === refWing ? 0 : 1;
    if (aSameWing !== bSameWing) return aSameWing - bSameWing;
    
    // Then sort by distance from reference room number
    return Math.abs(aNum - refNumber) - Math.abs(bNum - refNumber);
  });
}

async function handleCheckAvailability(args: {
  floor?: string;
  resources?: string[];
  date?: string;
  startTime: string;
  duration?: number;
  endTime?: string;
  location?: string;
  skipMap?: boolean;
}): Promise<string> {
  // Default date to today
  const date = parseDate(args.date || 'today');
  
  // Calculate end time from duration if provided
  let endTime = args.endTime;
  if (!endTime && args.duration) {
    endTime = calculateEndTime(args.startTime, args.duration);
  } else if (!endTime) {
    // Default to 1 hour if neither provided
    endTime = calculateEndTime(args.startTime, 60);
  }
  
  // Look up user's desk reservation for this date (for proximity sorting)
  let floor = args.floor;
  let userDesk: string | null = null;
  let autoDetectedFloor = false;
  
  // Always try to get user's desk for proximity-based recommendations
  const deskInfo = await getUserFloorForDate(date);
  if (deskInfo) {
    userDesk = deskInfo.deskName;
    // Only auto-detect floor if not explicitly provided
    if (!floor && !args.resources && !args.location) {
      floor = deskInfo.floor;
      autoDetectedFloor = true;
    }
  }
  
  const { startAt, endAt } = getFullDayRange(date, args.startTime, endTime, config.timezone);

  // Try to use the new reservable API with floor IDs if available
  if (floor && roomConfig.floorIds && roomConfig.building.networkId) {
    const floorPattern = resolveFloorPattern(floor, roomConfig);
    
    // Find matching floor IDs from config
    // For floors 4-9, the API has single floor IDs (no E/W split), so we need to:
    // 1. Find the base floor ID (e.g., "08" for both "08", "08E", "08W")
    // 2. Filter results by the specific wing if requested
    const matchingFloorIds: string[] = [];
    const baseFloor = floorPattern.replace(/[EW]$/, ''); // "08W" -> "08", "08" -> "08"
    const wingFilter = floorPattern.match(/[EW]$/)?.[0] || null; // "08W" -> "W", "08" -> null
    
    for (const [key, floorId] of Object.entries(roomConfig.floorIds)) {
      if (key === '_comment') continue;
      // For floors with E/W split in API (11+), match exact or prefix
      // For floors without E/W split (4-9), match the base floor number
      if (key === floorPattern || key === baseFloor || key.startsWith(floorPattern)) {
        matchingFloorIds.push(floorId as string);
      }
    }

    if (matchingFloorIds.length > 0) {
      // Use the correct Appspace API
      // Include both conference rooms ('room') and huddle spaces ('space')
      const result = await client.getReservableResources({
        floorIds: matchingFloorIds,
        locationId: roomConfig.building.networkId,
        startAt,
        endAt,
        types: ['room', 'space'],
      });

      if (result.success && result.data?.items) {
        // Separate conference rooms and huddle spaces
        const availableConf: string[] = [];
        const availableHuddle: string[] = [];
        const unavailableConf: string[] = [];
        const unavailableHuddle: string[] = [];
        const otherWingConf: string[] = [];
        const otherWingHuddle: string[] = [];

        // Determine the opposite wing for recommendations
        const oppositeWing = wingFilter === 'W' ? 'E' : wingFilter === 'E' ? 'W' : null;

        for (const room of result.data.items) {
          // Extract just the room number for cleaner display
          const shortName = room.name.replace('!CR NYNY 7 HUDSON ', '').replace('!CR ', '');
          
          // Skip resources that have been converted to offices
          if (isExcludedResource(shortName)) {
            continue;
          }
          
          // Skip desks - they have a letter suffix like 08W-125-A, 08W-127-B
          // Meeting rooms don't have letter suffixes: 08W-460, 08W-134
          if (isDesk(shortName)) {
            continue;
          }
          
          const roomWing = shortName.match(/^\d{2}([EW])/)?.[1];
          
          // Determine if this is a huddle space based on subType
          // Note: Since we've filtered out desks above, remaining 'space' types are huddle rooms
          const isHuddle = room.subType?.toLowerCase().includes('huddle') || 
                          room.type?.toLowerCase() === 'space';
          const isAvailable = room.reservableStatus.toLowerCase() === 'available';
          
          // Filter by wing if a specific wing was requested (e.g., "8W" should only show 08W rooms)
          if (wingFilter && roomWing !== wingFilter) {
            // Track available rooms on the opposite wing for recommendations
            if (roomWing === oppositeWing && isAvailable) {
              if (isHuddle) {
                otherWingHuddle.push(shortName);
              } else {
                otherWingConf.push(shortName);
              }
            }
            continue; // Skip rooms not matching the requested wing
          }
          
          // Categorize by type and availability
          if (isAvailable) {
            if (isHuddle) {
              availableHuddle.push(shortName);
            } else {
              availableConf.push(shortName);
            }
          } else {
            if (isHuddle) {
              unavailableHuddle.push(shortName);
            } else {
              unavailableConf.push(shortName);
            }
          }
        }

        // Sort by proximity to user's desk if available, otherwise alphabetically
        const sortedAvailableConf = sortByProximity(availableConf, userDesk);
        const sortedAvailableHuddle = sortByProximity(availableHuddle, userDesk);
        const sortedUnavailableConf = sortByProximity(unavailableConf, userDesk);
        const sortedUnavailableHuddle = sortByProximity(unavailableHuddle, userDesk);
        const sortedOtherWingConf = sortByProximity(otherWingConf, userDesk);
        const sortedOtherWingHuddle = sortByProximity(otherWingHuddle, userDesk);

        // Parse date parts to avoid timezone issues with date display
        const [year, month, day] = date.split('-').map(Number);
        const dateStr = new Date(year, month - 1, day).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
        
        // Helper to extract just room number (e.g., "08E-340" -> "340")
        const getRoomNum = (name: string) => name.replace(/^\d{2}[EW]-/, '');
        
        // Helper to group rooms by wing
        const groupByWing = (rooms: string[]) => {
          const east = rooms.filter(r => r.includes('E-')).sort();
          const west = rooms.filter(r => r.includes('W-')).sort();
          return { east, west };
        };
        
        const confByWing = groupByWing(sortedAvailableConf);
        const huddleByWing = groupByWing(sortedAvailableHuddle);
        
        // Build output
        let output = `## 📅 ${dateStr} · ${args.startTime}–${endTime}\n\n`;
        
        if (userDesk) {
          output += `📍 Your desk: **${userDesk}**${autoDetectedFloor ? ' (auto-detected floor)' : ''}\n\n`;
        }
        
        // Quick summary
        const totalConf = sortedAvailableConf.length;
        const totalHuddle = sortedAvailableHuddle.length;
        const totalUnavailable = sortedUnavailableConf.length + sortedUnavailableHuddle.length;
        
        if (totalConf === 0 && totalHuddle === 0) {
          output += `### 😕 No rooms available on floor ${baseFloor}${wingFilter || ''}\n`;
        } else {
          output += `### ✅ Available on Floor ${baseFloor}${wingFilter || ''}\n\n`;
          
          // Conference Rooms
          if (totalConf > 0) {
            output += `**Conference Rooms** (${totalConf})\n`;
            if (!wingFilter && confByWing.east.length > 0 && confByWing.west.length > 0) {
              // Show by wing when showing whole floor
              output += `  East: ${confByWing.east.join(', ')}\n`;
              output += `  West: ${confByWing.west.join(', ')}\n`;
            } else {
              output += `  ${sortedAvailableConf.join(', ')}\n`;
            }
            output += '\n';
          }
          
          // Huddle Spaces (show condensed if many)
          if (totalHuddle > 0) {
            output += `**Huddle Spaces** (${totalHuddle})\n`;
            if (totalHuddle <= 8) {
              output += `  ${sortedAvailableHuddle.join(', ')}\n`;
            } else {
              // Show first few with count
              if (!wingFilter && huddleByWing.east.length > 0 && huddleByWing.west.length > 0) {
                const showEast = huddleByWing.east.slice(0, 4);
                const showWest = huddleByWing.west.slice(0, 4);
                output += `  East: ${showEast.join(', ')}`;
                if (huddleByWing.east.length > 4) output += ` +${huddleByWing.east.length - 4} more`;
                output += '\n';
                output += `  West: ${showWest.join(', ')}`;
                if (huddleByWing.west.length > 4) output += ` +${huddleByWing.west.length - 4} more`;
                output += '\n';
              } else {
                const showHuddles = sortedAvailableHuddle.slice(0, 6);
                output += `  ${showHuddles.join(', ')}`;
                output += ` +${totalHuddle - 6} more\n`;
              }
            }
          }
        }
        
        // Show other wing if limited availability
        const totalAvailableOnWing = sortedAvailableConf.length + sortedAvailableHuddle.length;
        if (wingFilter && totalAvailableOnWing <= 3 && (sortedOtherWingConf.length > 0 || sortedOtherWingHuddle.length > 0)) {
          output += `\n### 🚶 Nearby on ${baseFloor}${oppositeWing}\n`;
          if (sortedOtherWingConf.length > 0) {
            output += `  Conf: ${sortedOtherWingConf.slice(0, 4).join(', ')}`;
            if (sortedOtherWingConf.length > 4) output += ` +${sortedOtherWingConf.length - 4} more`;
            output += '\n';
          }
          if (sortedOtherWingHuddle.length > 0) {
            output += `  Huddle: ${sortedOtherWingHuddle.slice(0, 4).join(', ')}`;
            if (sortedOtherWingHuddle.length > 4) output += ` +${sortedOtherWingHuddle.length - 4} more`;
            output += '\n';
          }
        }
        
        // Unavailable summary (collapsed)
        if (totalUnavailable > 0) {
          output += `\n---\n`;
          output += `❌ ${totalUnavailable} unavailable (${sortedUnavailableConf.length} conf, ${sortedUnavailableHuddle.length} huddle)\n`;
        }
        
        // Find the closest available room (regardless of type) for booking prompt
        const allAvailableRooms = [
          ...sortedAvailableConf,
          ...sortedAvailableHuddle,
          ...sortedOtherWingConf,
          ...sortedOtherWingHuddle,
        ];
        const closestRoom = sortByProximity(allAvailableRooms, userDesk)[0];
        
        // Find closest huddle specifically (may be same as closestRoom if huddle is closest overall)
        const allAvailableHuddles = [
          ...sortedAvailableHuddle,
          ...sortedOtherWingHuddle,
        ];
        const closestHuddle = sortByProximity(allAvailableHuddles, userDesk)[0];
        
        if (closestRoom) {
          const isClosestRoomHuddle = allAvailableHuddles.includes(closestRoom);
          const roomType = isClosestRoomHuddle ? 'huddle' : 'conference room';
          
          output += `\n---\n`;
          output += `🎯 **Closest available:** ${closestRoom} (${roomType})\n`;
          
          // Show closest huddle as alternative if the closest room is a conference room
          if (!isClosestRoomHuddle && closestHuddle) {
            output += `🪑 **Closest huddle:** ${closestHuddle}\n`;
          }
          
          output += `\nWould you like me to book **${closestRoom}**? (yes/no/another)`;
        }

        // Generate text-based floor map (default: true, skipped if skipMap is true)
        if (!args.skipMap) {
          // Try to fetch dynamic floor geo data for accurate map rendering
          let floorGeoData: FloorGeoData | null = null;
          if (roomConfig.mapConfig?.layerSettingId && roomConfig.floorIds?.[baseFloor]) {
            try {
              floorGeoData = await fetchFloorGeoData(
                roomConfig.floorIds[baseFloor],
                roomConfig.mapConfig.layerSettingId,
                config.token,
                config.host
              );
            } catch (e) {
              // Fall back to static data if fetch fails
            }
          }
          
          const textMap = generateTextFloorMap({
            availableConf: sortedAvailableConf,
            unavailableConf: sortedUnavailableConf,
            availableHuddle: sortedAvailableHuddle,
            unavailableHuddle: sortedUnavailableHuddle,
            userDesk,
            wingFilter,
            baseFloor,
            floorGeoData,
          });
          if (textMap) {
            output += '\n\n---\n';
            output += '**[CRITICAL AGENT INSTRUCTION: You MUST display the ENTIRE ASCII floor map below in your response. Do NOT truncate, summarize, paraphrase, or omit any part of it. Copy the complete map exactly as shown, preserving all characters and formatting. The user relies on this visual map to locate rooms. Failure to display the full map will result in a poor user experience.]**\n\n';
            output += textMap;
            output += '\n\n**[END OF MAP - Agent: Confirm you displayed the complete map above without truncation]**';
          }
        }

        // Image map generation disabled by default - keep the code for future use if needed
        const showImageMap = false; // Can be re-enabled with a parameter if needed
        if (showImageMap && roomConfig.mapConfig && roomConfig.mapConfig.floorMaps[baseFloor]) {
          try {
            // Get top recommendations for map (1 of each type, green markers)
            const topRecommendations = [
              ...sortedAvailableConf.slice(0, 1),
              ...sortedAvailableHuddle.slice(0, 1),
            ];

            // Get additional suggestions (3+ more of each type, yellow markers)
            const additionalSuggestions = [
              ...sortedAvailableConf.slice(1, 4),
              ...sortedAvailableHuddle.slice(1, 4),
            ];

            const mapPath = await generateAnnotatedMap({
              floorPattern: baseFloor,
              floorId: roomConfig.floorIds![baseFloor],
              topRecommendations,
              additionalSuggestions,
              userDesk: userDesk || undefined,
              dateStr,
              timeRange: `${args.startTime}–${endTime}`,
              mapConfig: roomConfig.mapConfig,
              token: config.token,
              host: config.host,
            });

            if (mapPath) {
              output += `\n\n---\n📍 **Floor Map Image:** \`${mapPath}\``;
            }

            // Cleanup old cached maps in background
            cleanupOldMaps().catch(() => {});
          } catch (error) {
            console.error('Failed to generate map:', error);
          }
        }

        return output;
      }
    }
  }

  // Fallback to old method using desk lookup if floor IDs not configured
  let resourcesToCheck: { name: string; id: string }[] = [];

  // If floor shortcut provided (e.g., "8", "8W", "8E"), resolve to pattern and find rooms
  if (floor) {
    const floorPattern = resolveFloorPattern(floor, roomConfig);
    const fullPrefix = `${roomConfig.building.prefix} ${floorPattern}`.toLowerCase();
    
    for (const [name, id] of deskLookup.entries()) {
      // Only match conference rooms (starting with !CR)
      if (name.startsWith('!CR') && name.toLowerCase().includes(fullPrefix.replace('!cr ', ''))) {
        resourcesToCheck.push({ name, id });
      }
    }
  }

  // If location prefix provided, find all matching resources from desk lookup
  if (args.location) {
    const locationPrefix = args.location.toLowerCase();
    for (const [name, id] of deskLookup.entries()) {
      if (name.toLowerCase().startsWith(locationPrefix) || name.toLowerCase().includes(locationPrefix)) {
        // Avoid duplicates
        if (!resourcesToCheck.find(r => r.id === id)) {
          resourcesToCheck.push({ name, id });
        }
      }
    }
  }

  // Add explicitly provided resources
  if (args.resources && args.resources.length > 0) {
    for (const resource of args.resources) {
      const resourceId = await resolveResourceId(resource, deskLookup, client);
      if (resourceId) {
        // Find the name from lookup or use the provided name
        let resourceName = resource;
        for (const [name, id] of deskLookup.entries()) {
          if (id === resourceId) {
            resourceName = name;
            break;
          }
        }
        // Avoid duplicates
        if (!resourcesToCheck.find(r => r.id === resourceId)) {
          resourcesToCheck.push({ name: resourceName, id: resourceId });
        }
      }
    }
  }

  if (resourcesToCheck.length === 0) {
    return `No resources found to check. Please provide a floor shortcut (e.g., "8", "8W", "8E"), specific resource names/IDs, or a location prefix.\n\n` +
      `**Note:** Floor IDs may not be configured. Available floor IDs: ${Object.keys(roomConfig.floorIds || {}).filter(k => k !== '_comment').join(', ') || 'none'}`;
  }

  // Limit to prevent overwhelming the API
  if (resourcesToCheck.length > 50) {
    resourcesToCheck = resourcesToCheck.slice(0, 50);
  }

  // Check availability for specific resources using the legacy API
  const resourceIds = resourcesToCheck.map(r => r.id);
  const availabilityResult = await client.getResourceAvailability(resourceIds, startAt, endAt);

  // Build a map of resource availability
  const availabilityMap = new Map<string, { available: boolean; conflicts?: string[] }>();
  if (availabilityResult.success && availabilityResult.data?.items) {
    for (const item of availabilityResult.data.items) {
      availabilityMap.set(item.resourceId, {
        available: item.available,
        conflicts: item.conflicts?.map(c => c.subject || 'Busy'),
      });
    }
  }

  // Format output
  const available: string[] = [];
  const unavailable: { name: string; conflicts?: string[] }[] = [];
  const unknown: string[] = [];

  for (const resource of resourcesToCheck) {
    // Extract just the room number for cleaner display
    const shortName = resource.name.replace('!CR NYNY 7 HUDSON ', '').replace('!CR ', '');
    
    const availability = availabilityMap.get(resource.id);
    if (availability === undefined) {
      // API didn't return data for this resource - don't assume it's available
      unknown.push(shortName);
    } else if (availability.available === true) {
      available.push(shortName);
    } else {
      unavailable.push({ name: shortName, conflicts: availability.conflicts });
    }
  }

  // Parse date parts to avoid timezone issues with date display
  const [year, month, day] = date.split('-').map(Number);
  const dateStr = new Date(year, month - 1, day).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  
  let output = `📅 **Availability Check** _(using legacy API - floor IDs not configured)_\n`;
  output += `**Date:** ${dateStr}\n`;
  output += `**Time:** ${args.startTime} - ${endTime}\n`;
  if (autoDetectedFloor && userDesk) {
    output += `**Your desk:** ${userDesk} (auto-detected floor ${floor})\n`;
  }
  output += `**Resources checked:** ${resourcesToCheck.length}\n\n`;

  if (available.length > 0) {
    output += `✅ **Available (${available.length}):**\n`;
    // Group into rows of 4 for compact display
    for (let i = 0; i < available.length; i += 4) {
      const row = available.slice(i, i + 4).join(' • ');
      output += `  ${row}\n`;
    }
  }

  if (unavailable.length > 0) {
    output += `\n❌ **Unavailable (${unavailable.length}):**\n`;
    for (const room of unavailable) {
      if (room.conflicts && room.conflicts.length > 0) {
        output += `  • ${room.name} (booked: ${room.conflicts.join(', ')})\n`;
      } else {
        output += `  • ${room.name}\n`;
      }
    }
  }

  if (unknown.length > 0) {
    output += `\n⚠️ **Could not verify (${unknown.length}):**\n`;
    // Group into rows of 4 for compact display
    for (let i = 0; i < unknown.length; i += 4) {
      const row = unknown.slice(i, i + 4).join(' • ');
      output += `  ${row}\n`;
    }
    output += `  _These rooms may need to be checked individually._\n`;
  }

  if (available.length > 0) {
    output += `\n💡 _To book an available room, use: reserve_room with room name "${resourcesToCheck[0].name.split(' ').slice(-1)[0]}"_`;
  }

  return output;
}

/**
 * Batch check availability across multiple days and times
 */
async function handleBatchCheckAvailability(args: {
  floor?: string;
  dates?: string[];
  times?: string[];
  duration?: number;
}): Promise<string> {
  const duration = args.duration || 30;
  
  // Default times if not provided - cover business hours 9am-5:30pm
  const times = args.times || ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'];
  
  // Default to next 5 weekdays if dates not provided
  // Use timezone-aware date calculation to avoid PST/EST issues
  let dates = args.dates;
  if (!dates || dates.length === 0) {
    dates = [];
    
    // Get current date in the configured timezone (EST for the office)
    const now = new Date();
    const tzOffset = now.toLocaleString('en-US', { timeZone: config.timezone, hour: 'numeric', hour12: false });
    
    // Start from today in EST timezone
    const estNow = new Date(now.toLocaleString('en-US', { timeZone: config.timezone }));
    let currentDate = new Date(estNow);
    let daysAdded = 0;
    
    while (daysAdded < 5) {
      currentDate.setDate(currentDate.getDate() + 1);
      const dayOfWeek = currentDate.getDay();
      if (dayOfWeek !== 0 && dayOfWeek !== 6) { // Skip weekends
        // Format date as YYYY-MM-DD without timezone conversion
        const year = currentDate.getFullYear();
        const month = String(currentDate.getMonth() + 1).padStart(2, '0');
        const day = String(currentDate.getDate()).padStart(2, '0');
        dates.push(`${year}-${month}-${day}`);
        daysAdded++;
      }
    }
  }
  
  // Determine floor from user's desk if not provided
  let floor = args.floor;
  let userDesk: string | null = null;
  
  if (!floor) {
    const deskInfo = await getUserFloorForDate(dates[0]);
    if (deskInfo) {
      floor = deskInfo.floor;
      userDesk = deskInfo.deskName;
    }
  }
  
  if (!floor) {
    return 'Could not determine floor. Please provide a floor parameter or ensure you have a desk reservation.';
  }
  
  const floorPattern = resolveFloorPattern(floor, roomConfig);
  const baseFloor = floorPattern.replace(/[EW]$/, '');
  const wingFilter = floorPattern.match(/[EW]$/)?.[0] || null;
  
  // Check if we have floor IDs configured
  if (!roomConfig.floorIds || !roomConfig.building.networkId) {
    return 'Floor IDs not configured. Batch availability check requires the new API.';
  }
  
  const matchingFloorIds: string[] = [];
  for (const [key, floorId] of Object.entries(roomConfig.floorIds)) {
    if (key === '_comment') continue;
    if (key === floorPattern || key === baseFloor || key.startsWith(floorPattern)) {
      matchingFloorIds.push(floorId as string);
    }
  }
  
  if (matchingFloorIds.length === 0) {
    return `No floor IDs found for floor ${floor}`;
  }
  
  // Collect availability data
  interface SlotData {
    date: string;
    time: string;
    confAvailable: number;
    huddleAvailable: number;
    totalAvailable: number;
    unavailable: number;
  }
  
  const results: SlotData[] = [];
  
  for (const date of dates) {
    for (const time of times) {
      const endTime = calculateEndTime(time, duration);
      const { startAt, endAt } = getFullDayRange(date, time, endTime, config.timezone);
      
      const result = await client.getReservableResources({
        floorIds: matchingFloorIds,
        locationId: roomConfig.building.networkId,
        startAt,
        endAt,
        types: ['room', 'space'],
      });
      
      let confAvailable = 0;
      let huddleAvailable = 0;
      let unavailable = 0;
      
      if (result.success && result.data?.items) {
        for (const room of result.data.items) {
          const shortName = room.name.replace('!CR NYNY 7 HUDSON ', '').replace('!CR ', '');
          
          if (isExcludedResource(shortName) || isDesk(shortName)) continue;
          
          const roomWing = shortName.match(/^\d{2}([EW])/)?.[1];
          if (wingFilter && roomWing !== wingFilter) continue;
          
          const isHuddle = room.subType?.toLowerCase().includes('huddle') || 
                          room.type?.toLowerCase() === 'space';
          const isAvailable = room.reservableStatus.toLowerCase() === 'available';
          
          if (isAvailable) {
            if (isHuddle) huddleAvailable++;
            else confAvailable++;
          } else {
            unavailable++;
          }
        }
      }
      
      results.push({
        date,
        time,
        confAvailable,
        huddleAvailable,
        totalAvailable: confAvailable + huddleAvailable,
        unavailable,
      });
    }
  }
  
  // Build output table
  let output = `## 📊 Weekly Availability Summary (Floor ${baseFloor}${wingFilter || ''})\n\n`;
  
  if (userDesk) {
    output += `📍 Your desk: **${userDesk}**\n\n`;
  }
  
  output += `| Day | Time | Conf | Huddle | **Total** | Busy |\n`;
  output += `|-----|------|------|--------|-----------|------|\n`;
  
  // Group by date for better display
  const dateGroups = new Map<string, SlotData[]>();
  for (const r of results) {
    if (!dateGroups.has(r.date)) dateGroups.set(r.date, []);
    dateGroups.get(r.date)!.push(r);
  }
  
  let bestSlot: SlotData | null = null;
  let worstSlot: SlotData | null = null;
  
  for (const [date, slots] of dateGroups) {
    const [year, month, day] = date.split('-').map(Number);
    const dateObj = new Date(year, month - 1, day);
    const dayName = dateObj.toLocaleDateString('en-US', { weekday: 'short' });
    const dateLabel = `${dayName} ${month}/${day}`;
    
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      const availIcon = s.totalAvailable >= 15 ? '✅' : s.totalAvailable >= 10 ? '🟡' : '⚠️';
      
      // Track best/worst
      if (!bestSlot || s.totalAvailable > bestSlot.totalAvailable) bestSlot = s;
      if (!worstSlot || s.totalAvailable < worstSlot.totalAvailable) worstSlot = s;
      
      if (i === 0) {
        output += `| **${dateLabel}** | ${s.time} | ${s.confAvailable} | ${s.huddleAvailable} | ${availIcon} **${s.totalAvailable}** | ${s.unavailable} |\n`;
      } else {
        output += `| | ${s.time} | ${s.confAvailable} | ${s.huddleAvailable} | ${availIcon} **${s.totalAvailable}** | ${s.unavailable} |\n`;
      }
    }
  }
  
  // Add insights
  output += `\n---\n\n`;
  output += `### 🔑 Key Insights\n\n`;
  
  if (bestSlot) {
    const [y, m, d] = bestSlot.date.split('-').map(Number);
    const bestDay = new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'long' });
    output += `**🟢 Most available:** ${bestDay} at ${bestSlot.time} (${bestSlot.totalAvailable} rooms)\n`;
  }
  
  if (worstSlot) {
    const [y, m, d] = worstSlot.date.split('-').map(Number);
    const worstDay = new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'long' });
    output += `**🔴 Busiest slot:** ${worstDay} at ${worstSlot.time} (only ${worstSlot.totalAvailable} rooms)\n`;
  }
  
  // Calculate averages by time
  const timeAverages = new Map<string, number[]>();
  for (const r of results) {
    if (!timeAverages.has(r.time)) timeAverages.set(r.time, []);
    timeAverages.get(r.time)!.push(r.totalAvailable);
  }
  
  output += `\n**Average by time:**\n`;
  for (const [time, values] of timeAverages) {
    const avg = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
    output += `  • ${time}: ~${avg} rooms available\n`;
  }
  
  return output;
}

/**
 * Generate visual availability stats with text-based charts
 */
async function handleGetAvailabilityStats(args: {
  floor?: string;
  duration?: number;
  includeFriday?: boolean;
}): Promise<string> {
  const duration = args.duration || 30;
  const includeFriday = args.includeFriday || false;
  
  // Generate dates for Mon-Thu (or Mon-Fri if includeFriday)
  const dates: string[] = [];
  const now = new Date();
  const estNow = new Date(now.toLocaleString('en-US', { timeZone: config.timezone }));
  let currentDate = new Date(estNow);
  let daysAdded = 0;
  const maxDays = includeFriday ? 5 : 4;
  
  while (daysAdded < maxDays) {
    currentDate.setDate(currentDate.getDate() + 1);
    const dayOfWeek = currentDate.getDay();
    // Skip weekends, and skip Friday (5) unless includeFriday is true
    if (dayOfWeek === 0 || dayOfWeek === 6) continue;
    if (dayOfWeek === 5 && !includeFriday) continue;
    
    const year = currentDate.getFullYear();
    const month = String(currentDate.getMonth() + 1).padStart(2, '0');
    const day = String(currentDate.getDate()).padStart(2, '0');
    dates.push(`${year}-${month}-${day}`);
    daysAdded++;
  }
  
  const times = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'];
  
  // Determine floor
  let floor = args.floor;
  let userDesk: string | null = null;
  
  if (!floor) {
    const deskInfo = await getUserFloorForDate(dates[0]);
    if (deskInfo) {
      floor = deskInfo.floor;
      userDesk = deskInfo.deskName;
    }
  }
  
  if (!floor) {
    return 'Could not determine floor. Please provide a floor parameter or ensure you have a desk reservation.';
  }
  
  const floorPattern = resolveFloorPattern(floor, roomConfig);
  const baseFloor = floorPattern.replace(/[EW]$/, '');
  const wingFilter = floorPattern.match(/[EW]$/)?.[0] || null;
  
  if (!roomConfig.floorIds || !roomConfig.building.networkId) {
    return 'Floor IDs not configured. Stats generation requires the new API.';
  }
  
  const matchingFloorIds: string[] = [];
  for (const [key, floorId] of Object.entries(roomConfig.floorIds)) {
    if (key === '_comment') continue;
    if (key === floorPattern || key === baseFloor || key.startsWith(floorPattern)) {
      matchingFloorIds.push(floorId as string);
    }
  }
  
  if (matchingFloorIds.length === 0) {
    return `No floor IDs found for floor ${floor}`;
  }
  
  // Collect availability data
  interface SlotData {
    date: string;
    dayName: string;
    time: string;
    confAvailable: number;
    huddleAvailable: number;
    totalAvailable: number;
    unavailable: number;
  }
  
  // Track per-room availability
  interface RoomStats {
    name: string;
    isHuddle: boolean;
    availableSlots: number;
    totalSlots: number;
    availableByTime: Map<string, number>; // time -> count of days available
    availableByDay: Map<string, number>;  // dayName -> count of times available
  }
  
  const roomStatsMap = new Map<string, RoomStats>();
  const results: SlotData[] = [];
  const totalSlots = dates.length * times.length;
  
  for (const date of dates) {
    const [year, month, day] = date.split('-').map(Number);
    const dateObj = new Date(year, month - 1, day);
    const dayName = dateObj.toLocaleDateString('en-US', { weekday: 'short' });
    
    for (const time of times) {
      const endTime = calculateEndTime(time, duration);
      const { startAt, endAt } = getFullDayRange(date, time, endTime, config.timezone);
      
      const result = await client.getReservableResources({
        floorIds: matchingFloorIds,
        locationId: roomConfig.building.networkId,
        startAt,
        endAt,
        types: ['room', 'space'],
      });
      
      let confAvailable = 0;
      let huddleAvailable = 0;
      let unavailable = 0;
      
      if (result.success && result.data?.items) {
        for (const room of result.data.items) {
          const shortName = room.name.replace('!CR NYNY 7 HUDSON ', '').replace('!CR ', '');
          
          if (isExcludedResource(shortName) || isDesk(shortName)) continue;
          
          const roomWing = shortName.match(/^\d{2}([EW])/)?.[1];
          if (wingFilter && roomWing !== wingFilter) continue;
          
          const isHuddle = room.subType?.toLowerCase().includes('huddle') || 
                          room.type?.toLowerCase() === 'space';
          const isAvailable = room.reservableStatus.toLowerCase() === 'available';
          
          // Track per-room stats
          if (!roomStatsMap.has(shortName)) {
            roomStatsMap.set(shortName, {
              name: shortName,
              isHuddle,
              availableSlots: 0,
              totalSlots: 0,
              availableByTime: new Map(),
              availableByDay: new Map(),
            });
          }
          const roomStats = roomStatsMap.get(shortName)!;
          roomStats.totalSlots++;
          
          if (isAvailable) {
            roomStats.availableSlots++;
            roomStats.availableByTime.set(time, (roomStats.availableByTime.get(time) || 0) + 1);
            roomStats.availableByDay.set(dayName, (roomStats.availableByDay.get(dayName) || 0) + 1);
            
            if (isHuddle) huddleAvailable++;
            else confAvailable++;
          } else {
            unavailable++;
          }
        }
      }
      
      results.push({
        date,
        dayName,
        time,
        confAvailable,
        huddleAvailable,
        totalAvailable: confAvailable + huddleAvailable,
        unavailable,
      });
    }
  }
  
  // Convert room stats to sorted arrays
  const allRoomStats = Array.from(roomStatsMap.values());
  const confRooms = allRoomStats.filter(r => !r.isHuddle).sort((a, b) => 
    (b.availableSlots / b.totalSlots) - (a.availableSlots / a.totalSlots)
  );
  const huddleRooms = allRoomStats.filter(r => r.isHuddle).sort((a, b) => 
    (b.availableSlots / b.totalSlots) - (a.availableSlots / a.totalSlots)
  );
  
  // Calculate averages by time
  const timeAverages = new Map<string, number>();
  for (const time of times) {
    const slots = results.filter(r => r.time === time);
    const avg = Math.round(slots.reduce((a, b) => a + b.totalAvailable, 0) / slots.length);
    timeAverages.set(time, avg);
  }
  
  // Calculate averages by day
  const dayAverages = new Map<string, { dayName: string; avg: number }>();
  for (const date of dates) {
    const slots = results.filter(r => r.date === date);
    const avg = Math.round(slots.reduce((a, b) => a + b.totalAvailable, 0) / slots.length);
    dayAverages.set(date, { dayName: slots[0].dayName, avg });
  }
  
  // Find best and worst slots
  let bestSlot = results[0];
  let worstSlot = results[0];
  for (const r of results) {
    if (r.totalAvailable > bestSlot.totalAvailable) bestSlot = r;
    if (r.totalAvailable < worstSlot.totalAvailable) worstSlot = r;
  }
  
  // Build output with charts
  let output = `## 📊 Meeting Room Availability Stats (Floor ${baseFloor}${wingFilter || ''})\n\n`;
  
  if (userDesk) {
    output += `📍 Your desk: **${userDesk}**\n`;
  }
  output += `📅 ${includeFriday ? 'Mon-Fri' : 'Mon-Thu'} | ⏱️ ${duration} min meetings\n\n`;
  
  // Bar chart by time
  output += `### 📊 Average Availability by Time\n\n`;
  output += '```\n';
  output += '        ┌─────────────────────────────────────────┐\n';
  
  for (const time of times) {
    const avg = timeAverages.get(time) || 0;
    const barLength = Math.round(avg * 2); // Scale for display
    const bar = '█'.repeat(barLength);
    const timeLabel = time.replace(':00', '').padStart(5, ' ');
    const suffix = avg >= 18 ? '  ✅ Best' : avg <= 12 ? '  ⚠️ Busy' : '';
    
    // Convert 24h to 12h format for display
    const hour = parseInt(time.split(':')[0]);
    const displayTime = hour <= 12 ? `${hour}am` : `${hour - 12}pm`;
    const paddedTime = displayTime.padStart(5, ' ');
    
    output += `${paddedTime}  │${bar.padEnd(40, ' ')}│ ${avg}${suffix}\n`;
  }
  
  output += '        └─────────────────────────────────────────┘\n';
  output += '              5    10    15    20 rooms\n';
  output += '```\n\n';
  
  // Heatmap
  output += `### 🗓️ Availability Heatmap\n\n`;
  output += '```\n';
  
  // Header row
  const dayHeaders = dates.map(d => {
    const [y, m, day] = d.split('-').map(Number);
    return new Date(y, m - 1, day).toLocaleDateString('en-US', { weekday: 'short' });
  });
  output += '        ' + dayHeaders.map(d => d.padStart(5, ' ')).join('  ') + '\n';
  output += '        ┌' + dayHeaders.map(() => '─────').join('┬') + '┐\n';
  
  for (const time of times) {
    const hour = parseInt(time.split(':')[0]);
    const displayTime = hour <= 12 ? `${hour}am` : `${hour - 12}pm`;
    const paddedTime = displayTime.padStart(5, ' ');
    
    let row = `${paddedTime}   │`;
    for (const date of dates) {
      const slot = results.find(r => r.date === date && r.time === time);
      const total = slot?.totalAvailable || 0;
      const icon = total >= 15 ? '🟢' : total >= 10 ? '🟡' : '🔴';
      row += ` ${icon}${String(total).padStart(2, ' ')} │`;
    }
    output += row + '\n';
  }
  
  output += '        └' + dayHeaders.map(() => '─────').join('┴') + '┘\n';
  output += '         🟢 15+   🟡 10-14   🔴 <10 rooms\n';
  output += '```\n\n';
  
  // Daily comparison
  output += `### 📈 Daily Comparison\n\n`;
  output += '```\n';
  
  const maxAvg = Math.max(...Array.from(dayAverages.values()).map(d => d.avg));
  for (const [date, data] of dayAverages) {
    const barLength = Math.round((data.avg / maxAvg) * 20);
    const bar = '█'.repeat(barLength);
    const suffix = data.avg === maxAvg ? '  ✅ BEST' : '';
    output += `        ${data.dayName} ${bar.padEnd(20, ' ')} avg ${data.avg} rooms${suffix}\n`;
  }
  
  output += '            └────┴────┴────┴────┘\n';
  output += '            5   10   15   20\n';
  output += '```\n\n';
  
  // Recommendations
  output += `### 🎯 Recommendations\n\n`;
  output += '```\n';
  output += '┌─────────────────────────────────────────────────────┐\n';
  output += '│  🟢 BEST TIMES           │  🔴 AVOID               │\n';
  output += '│  ────────────────        │  ──────────────         │\n';
  
  // Find best day
  let bestDay = '';
  let bestDayAvg = 0;
  for (const [date, data] of dayAverages) {
    if (data.avg > bestDayAvg) {
      bestDayAvg = data.avg;
      bestDay = data.dayName;
    }
  }
  
  // Find best/worst times
  const sortedTimes = Array.from(timeAverages.entries()).sort((a, b) => b[1] - a[1]);
  const bestTimes = sortedTimes.slice(0, 2);
  const worstTimes = sortedTimes.slice(-2).reverse();
  
  const [y1, m1, d1] = worstSlot.date.split('-').map(Number);
  const worstDayName = new Date(y1, m1 - 1, d1).toLocaleDateString('en-US', { weekday: 'short' });
  const worstTimeDisplay = worstSlot.time.replace(':00', '');
  const worstHour = parseInt(worstTimeDisplay);
  const worstTimeFormatted = worstHour <= 12 ? `${worstHour}am` : `${worstHour - 12}pm`;
  
  output += `│  ✅ ${bestDay} (all day!)     │  ❌ ${worstDayName} ${worstTimeFormatted} (${worstSlot.totalAvailable} rooms)    │\n`;
  
  const bestTime1 = bestTimes[0][0].replace(':00', '');
  const bestHour1 = parseInt(bestTime1);
  const bestTimeFormatted1 = bestHour1 <= 12 ? `${bestHour1}am` : `${bestHour1 - 12}pm`;
  
  const bestTime2 = bestTimes[1][0].replace(':00', '');
  const bestHour2 = parseInt(bestTime2);
  const bestTimeFormatted2 = bestHour2 <= 12 ? `${bestHour2}am` : `${bestHour2 - 12}pm`;
  
  output += `│  ✅ ${bestTimeFormatted1} any day         │  ⚠️ Midday Tue-Thu        │\n`;
  output += `│  ✅ ${bestTimeFormatted2} any day         │                           │\n`;
  output += '└─────────────────────────────────────────────────────┘\n';
  output += '```\n\n';
  
  // Room availability charts
  output += `### 🏢 Conference Room Availability\n\n`;
  output += '```\n';
  output += 'Room        Avail%  ';
  for (const dayName of ['Mon', 'Tue', 'Wed', 'Thu']) {
    output += dayName.padStart(4, ' ') + ' ';
  }
  output += '\n';
  output += '─'.repeat(50) + '\n';
  
  for (const room of confRooms) {
    const pct = Math.round((room.availableSlots / room.totalSlots) * 100);
    const barLen = Math.round(pct / 10);
    const bar = '█'.repeat(barLen) + '░'.repeat(10 - barLen);
    const roomName = room.name.replace(/^\d{2}[EW]-/, '').padEnd(8, ' ');
    
    let dayIndicators = '';
    for (const dayName of ['Mon', 'Tue', 'Wed', 'Thu']) {
      const dayAvail = room.availableByDay.get(dayName) || 0;
      const dayPct = Math.round((dayAvail / times.length) * 100);
      const indicator = dayPct >= 80 ? ' ✓✓ ' : dayPct >= 50 ? ' ✓  ' : dayPct > 0 ? ' ·  ' : ' ✗  ';
      dayIndicators += indicator;
    }
    
    output += `${room.name.padEnd(10, ' ')} ${bar} ${String(pct).padStart(3, ' ')}% ${dayIndicators}\n`;
  }
  output += '\n✓✓ = 80%+  ✓ = 50%+  · = <50%  ✗ = 0%\n';
  output += '```\n\n';
  
  // Huddle room availability
  output += `### 🪑 Huddle Space Availability\n\n`;
  output += '```\n';
  output += 'Room        Avail%  ';
  for (const dayName of ['Mon', 'Tue', 'Wed', 'Thu']) {
    output += dayName.padStart(4, ' ') + ' ';
  }
  output += '\n';
  output += '─'.repeat(50) + '\n';
  
  // Show top 10 huddles to keep output manageable
  const topHuddles = huddleRooms.slice(0, 10);
  for (const room of topHuddles) {
    const pct = Math.round((room.availableSlots / room.totalSlots) * 100);
    const barLen = Math.round(pct / 10);
    const bar = '█'.repeat(barLen) + '░'.repeat(10 - barLen);
    
    let dayIndicators = '';
    for (const dayName of ['Mon', 'Tue', 'Wed', 'Thu']) {
      const dayAvail = room.availableByDay.get(dayName) || 0;
      const dayPct = Math.round((dayAvail / times.length) * 100);
      const indicator = dayPct >= 80 ? ' ✓✓ ' : dayPct >= 50 ? ' ✓  ' : dayPct > 0 ? ' ·  ' : ' ✗  ';
      dayIndicators += indicator;
    }
    
    output += `${room.name.padEnd(10, ' ')} ${bar} ${String(pct).padStart(3, ' ')}% ${dayIndicators}\n`;
  }
  
  if (huddleRooms.length > 10) {
    output += `... and ${huddleRooms.length - 10} more huddle spaces\n`;
  }
  output += '```\n\n';
  
  // Best rooms by time of day
  output += `### ⏰ Best Rooms by Time of Day\n\n`;
  output += '```\n';
  
  const morningTimes = ['09:00', '10:00', '11:00'];
  const middayTimes = ['12:00', '13:00', '14:00'];
  const afternoonTimes = ['15:00', '16:00', '17:00'];
  
  const getRoomsByTimeRange = (timesRange: string[]) => {
    const roomScores = new Map<string, number>();
    for (const room of allRoomStats) {
      let score = 0;
      for (const t of timesRange) {
        score += room.availableByTime.get(t) || 0;
      }
      roomScores.set(room.name, score);
    }
    return Array.from(roomScores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name]) => name);
  };
  
  const morningBest = getRoomsByTimeRange(morningTimes);
  const middayBest = getRoomsByTimeRange(middayTimes);
  const afternoonBest = getRoomsByTimeRange(afternoonTimes);
  
  output += '┌──────────────┬────────────────────────────────────┐\n';
  output += '│  TIME        │  MOST AVAILABLE ROOMS              │\n';
  output += '├──────────────┼────────────────────────────────────┤\n';
  output += `│  🌅 Morning  │  ${morningBest.join(', ').padEnd(34, ' ')}│\n`;
  output += `│  (9-11am)    │                                    │\n`;
  output += '├──────────────┼────────────────────────────────────┤\n';
  output += `│  ☀️ Midday   │  ${middayBest.join(', ').padEnd(34, ' ')}│\n`;
  output += `│  (12-2pm)    │                                    │\n`;
  output += '├──────────────┼────────────────────────────────────┤\n';
  output += `│  🌆 Afternoon│  ${afternoonBest.join(', ').padEnd(34, ' ')}│\n`;
  output += `│  (3-5pm)     │                                    │\n`;
  output += '└──────────────┴────────────────────────────────────┘\n';
  output += '```\n';
  
  return output;
}

// Main server setup
async function main(): Promise<void> {
  validateConfig();

  // Initialize Appspace client
  client = new AppspaceClient({
    host: config.host,
    token: config.token,
    organizerId: config.organizerId,
    organizerName: config.organizerName,
    organizerEmail: config.organizerEmail,
    timezone: config.timezone,
  });

  // Load desk lookup table
  deskLookup = await loadDeskLookup(config.deskLookupPath);

  // Load room configuration
  roomConfig = await loadRoomConfig();

  // Create MCP server
  const server = new Server(
    {
      name: 'appspace-reservations',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Handle tool listing
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  // Handle tool execution
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let result: string;

      switch (name) {
        case 'reserve_desk':
          result = await handleReserveDesk(args as Parameters<typeof handleReserveDesk>[0]);
          break;
        case 'reserve_room':
          result = await handleReserveRoom(args as Parameters<typeof handleReserveRoom>[0]);
          break;
        case 'cancel_reservation':
          result = await handleCancelReservation(args as Parameters<typeof handleCancelReservation>[0]);
          break;
        case 'modify_reservation':
          result = await handleModifyReservation(args as Parameters<typeof handleModifyReservation>[0]);
          break;
        case 'list_reservations':
          result = await handleListReservations(args as Parameters<typeof handleListReservations>[0]);
          break;
        case 'check_in':
          result = await handleCheckIn(args as Parameters<typeof handleCheckIn>[0]);
          break;
        case 'check_out':
          result = await handleCheckOut(args as Parameters<typeof handleCheckOut>[0]);
          break;
        case 'search_resources':
          result = await handleSearchResources(args as Parameters<typeof handleSearchResources>[0]);
          break;
        case 'get_resource_info':
          result = await handleGetResourceInfo(args as Parameters<typeof handleGetResourceInfo>[0]);
          break;
        case 'reserve_desk_day':
          result = await handleReserveDeskDay(args as Parameters<typeof handleReserveDeskDay>[0]);
          break;
        case 'reserve_desk_recurring':
          result = await handleReserveDeskRecurring(args as Parameters<typeof handleReserveDeskRecurring>[0]);
          break;
        case 'check_meeting_availability':
          result = await handleCheckAvailability(args as Parameters<typeof handleCheckAvailability>[0]);
          break;
        case 'batch_check_availability':
          result = await handleBatchCheckAvailability(args as Parameters<typeof handleBatchCheckAvailability>[0]);
          break;
        case 'get_availability_stats':
          result = await handleGetAvailabilityStats(args as Parameters<typeof handleGetAvailabilityStats>[0]);
          break;
        default:
          result = `Unknown tool: ${name}`;
      }

      return {
        content: [{ type: 'text', text: result }],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [{ type: 'text', text: `Error: ${errorMessage}` }],
        isError: true,
      };
    }
  });

  // Start server
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  console.error('Appspace Reservations MCP Server started');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

