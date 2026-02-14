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
    name: 'check_availability',
    description: 'Check availability of conference rooms for a meeting. If no floor is specified, automatically detects the floor from the user\'s desk reservation for that day. Accepts either duration (in minutes) or end time.',
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
      },
      required: ['startTime'],
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

/**
 * Sort rooms by proximity to a reference room number
 * e.g., if user is at 08W-125, prefer 08W-120, 08W-122 over 08W-464
 */
function sortByProximity(rooms: string[], referenceDesk: string | null): string[] {
  if (!referenceDesk) return rooms.sort();
  
  // Extract the room number from the reference desk (e.g., "08W-125-H" -> 125)
  const refMatch = referenceDesk.match(/\d{2}[EW]?-(\d+)/);
  const refNumber = refMatch ? parseInt(refMatch[1], 10) : 0;
  
  return rooms.sort((a, b) => {
    const aMatch = a.match(/\d{2}[EW]?-(\d+)/);
    const bMatch = b.match(/\d{2}[EW]?-(\d+)/);
    const aNum = aMatch ? parseInt(aMatch[1], 10) : 0;
    const bNum = bMatch ? parseInt(bMatch[1], 10) : 0;
    
    // Sort by distance from reference number
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
  
  // Auto-detect floor from desk reservation if not provided
  let floor = args.floor;
  let userDesk: string | null = null;
  let autoDetectedFloor = false;
  
  if (!floor && !args.resources && !args.location) {
    const deskInfo = await getUserFloorForDate(date);
    if (deskInfo) {
      floor = deskInfo.floor;
      userDesk = deskInfo.deskName;
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
      const result = await client.getReservableResources({
        floorIds: matchingFloorIds,
        locationId: roomConfig.building.networkId,
        startAt,
        endAt,
        types: ['room'],
      });

      if (result.success && result.data?.items) {
        const available: string[] = [];
        const unavailable: string[] = [];
        const otherWingAvailable: string[] = [];

        // Determine the opposite wing for recommendations
        const oppositeWing = wingFilter === 'W' ? 'E' : wingFilter === 'E' ? 'W' : null;

        for (const room of result.data.items) {
          // Extract just the room number for cleaner display
          const shortName = room.name.replace('!CR NYNY 7 HUDSON ', '').replace('!CR ', '');
          const roomWing = shortName.match(/^\d{2}([EW])/)?.[1];
          
          // Filter by wing if a specific wing was requested (e.g., "8W" should only show 08W rooms)
          if (wingFilter && roomWing !== wingFilter) {
            // Track available rooms on the opposite wing for recommendations
            if (roomWing === oppositeWing && room.reservableStatus.toLowerCase() === 'available') {
              otherWingAvailable.push(shortName);
            }
            continue; // Skip rooms not matching the requested wing
          }
          
          // API returns "Available"/"Unavailable" with capital letters
          if (room.reservableStatus.toLowerCase() === 'available') {
            available.push(shortName);
          } else {
            unavailable.push(shortName);
          }
        }

        // Sort by proximity to user's desk if available, otherwise alphabetically
        const sortedAvailable = sortByProximity(available, userDesk);
        const sortedUnavailable = sortByProximity(unavailable, userDesk);
        const sortedOtherWing = otherWingAvailable.sort();

        const totalChecked = sortedAvailable.length + sortedUnavailable.length;

        // Parse date parts to avoid timezone issues with date display
        const [year, month, day] = date.split('-').map(Number);
        const dateStr = new Date(year, month - 1, day).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
        
        let output = `📅 **Availability Check**\n`;
        output += `**Date:** ${dateStr}\n`;
        output += `**Time:** ${args.startTime} - ${endTime}\n`;
        if (autoDetectedFloor && userDesk) {
          output += `**Your desk:** ${userDesk} (auto-detected floor ${floor})\n`;
        }
        output += `**Resources checked:** ${totalChecked}${wingFilter ? ` (filtered to ${floorPattern} only)` : ''}\n\n`;

        if (sortedAvailable.length > 0) {
          output += `✅ **Available on ${baseFloor}${wingFilter || ''} (${sortedAvailable.length}):**\n`;
          for (let i = 0; i < sortedAvailable.length; i += 4) {
            const row = sortedAvailable.slice(i, i + 4).join(' • ');
            output += `  ${row}\n`;
          }
        } else {
          output += `😕 **No rooms available on ${baseFloor}${wingFilter || ''}**\n`;
        }

        // If few rooms available on user's wing (<= 2), show other wing options
        if (wingFilter && sortedAvailable.length <= 2 && sortedOtherWing.length > 0) {
          output += `\n🚶 **Also available on ${baseFloor}${oppositeWing} (${sortedOtherWing.length}):**\n`;
          for (let i = 0; i < Math.min(sortedOtherWing.length, 8); i += 4) {
            const row = sortedOtherWing.slice(i, i + 4).join(' • ');
            output += `  ${row}\n`;
          }
          if (sortedOtherWing.length > 8) {
            output += `  _...and ${sortedOtherWing.length - 8} more_\n`;
          }
        }

        if (sortedUnavailable.length > 0) {
          output += `\n❌ **Unavailable on ${baseFloor}${wingFilter || ''} (${sortedUnavailable.length}):**\n`;
          for (let i = 0; i < sortedUnavailable.length; i += 4) {
            const row = sortedUnavailable.slice(i, i + 4).join(' • ');
            output += `  ${row}\n`;
          }
        }

        const bestAvailable = sortedAvailable[0] || sortedOtherWing[0];
        if (bestAvailable) {
          output += `\n💡 _To book: reserve_room with room name "${bestAvailable}"_`;
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
        case 'check_availability':
          result = await handleCheckAvailability(args as Parameters<typeof handleCheckAvailability>[0]);
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

