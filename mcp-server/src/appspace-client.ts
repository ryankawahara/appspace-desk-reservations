/**
 * Appspace API Client
 * Handles all interactions with the Appspace reservation API
 */

export interface AppspaceConfig {
  host: string;
  token: string;
  organizerId: string;
  organizerName: string;
  organizerEmail: string;
  timezone?: string;
}

export interface ReservationResource {
  resourceId: string;
  resourceName: string;
  resourceType: string;
  resourceSubType?: string;
  resourceFloorId?: string;
  resourceFloorName?: string;
}

export interface Reservation {
  id: string;
  subject?: string;
  startAt: string;
  endAt: string;
  status: string;
  resourceIds: string[];
  resources?: ReservationResource[];
  organizer?: {
    id: string;
    name: string;
  };
}

export interface Resource {
  id: string;
  name: string;
  type: string;
  locationPath?: string;
  capacity?: number;
  amenities?: string[];
}

export interface ReservationRequest {
  resourceIds: string[];
  startAt: string;
  endAt: string;
  subject?: string;
  timezone?: string;
}

export interface ResourceSearchParams {
  type?: 'desk' | 'room' | 'all';
  startAt?: string;
  endAt?: string;
  search?: string;
  locationPath?: string;
  locationId?: string;
  capacity?: number;
  limit?: number;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export class AppspaceClient {
  private config: AppspaceConfig;

  constructor(config: AppspaceConfig) {
    this.config = {
      ...config,
      timezone: config.timezone || 'America/New_York',
    };
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<ApiResponse<T>> {
    const url = `${this.config.host}${endpoint}`;
    
    const headers: Record<string, string> = {
      'accept': 'application/json',
      'content-type': 'application/json;charset=UTF-8',
      'token': this.config.token,
      'x-appspace-request-timezone': this.config.timezone!,
      ...((options.headers as Record<string, string>) || {}),
    };

    try {
      const response = await fetch(url, {
        ...options,
        headers,
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          error: `HTTP ${response.status}: ${errorText}`,
        };
      }

      const data = await response.json();
      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Create a new reservation for desk or conference room
   */
  async createReservation(request: ReservationRequest): Promise<ApiResponse<Reservation>> {
    const body = {
      resourceIds: request.resourceIds,
      effectiveStartAt: request.startAt,
      effectiveEndAt: request.endAt,
      subject: request.subject || 'Reservation',
      organizer: {
        id: this.config.organizerId,
        name: this.config.organizerName,
      },
      sensitivity: 'Public',
      organizerAvailabilityType: 'Busy',
      attendees: [
        {
          displayName: this.config.organizerName,
          email: this.config.organizerEmail,
          resourceIds: request.resourceIds,
          attendanceType: 'InPerson',
          userId: this.config.organizerId,
          id: this.config.organizerId,
        },
      ],
      visitors: [],
      visitPurpose: '',
      isAllDay: false,
      startTimeZone: request.timezone || this.config.timezone,
      endTimeZone: request.timezone || this.config.timezone,
    };

    return this.request<Reservation>('/api/v3/reservation/reservations', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /**
   * Get user's reservations
   */
  async getMyReservations(params?: {
    startAt?: string;
    endAt?: string;
    status?: string;
    limit?: number;
  }): Promise<ApiResponse<{ items: Reservation[]; size: number }>> {
    const queryParams = new URLSearchParams({
      sort: 'startAt',
      status: params?.status || 'NotConfirmed,Pending,Checkin,Active,Conflict,Completed',
      includesourceobject: 'true',
      page: '1',
      start: '0',
      limit: String(params?.limit || 50),
      pagecount: String(params?.limit || 50),
    });

    if (params?.startAt) queryParams.append('startAt', params.startAt);
    if (params?.endAt) queryParams.append('endAt', params.endAt);

    return this.request(`/api/v3/reservation/users/me/events?${queryParams}`);
  }

  /**
   * Get a specific reservation by ID
   */
  async getReservation(reservationId: string): Promise<ApiResponse<Reservation>> {
    return this.request(`/api/v3/reservation/events/${reservationId}`);
  }

  /**
   * Cancel a reservation
   */
  async cancelReservation(reservationId: string): Promise<ApiResponse<void>> {
    return this.request(`/api/v3/reservation/events/${reservationId}`, {
      method: 'DELETE',
    });
  }

  /**
   * Update/modify a reservation
   */
  async updateReservation(
    reservationId: string,
    updates: Partial<ReservationRequest>
  ): Promise<ApiResponse<Reservation>> {
    const body: Record<string, unknown> = {};

    if (updates.startAt) body.effectiveStartAt = updates.startAt;
    if (updates.endAt) body.effectiveEndAt = updates.endAt;
    if (updates.subject) body.subject = updates.subject;
    if (updates.resourceIds) {
      body.resourceIds = updates.resourceIds;
      body.attendees = [
        {
          displayName: this.config.organizerName,
          email: this.config.organizerEmail,
          resourceIds: updates.resourceIds,
          attendanceType: 'InPerson',
          userId: this.config.organizerId,
          id: this.config.organizerId,
        },
      ];
    }

    return this.request<Reservation>(`/api/v3/reservation/events/${reservationId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  }

  /**
   * Check in to a reservation
   */
  async checkIn(
    reservationId: string,
    resourceIds: string[]
  ): Promise<ApiResponse<Reservation>> {
    return this.request<Reservation>(
      `/api/v3/reservation/events/${reservationId}/checkin`,
      {
        method: 'POST',
        body: JSON.stringify({ resourceIds }),
      }
    );
  }

  /**
   * Check out from a reservation (early checkout)
   */
  async checkOut(reservationId: string): Promise<ApiResponse<void>> {
    return this.request(`/api/v3/reservation/events/${reservationId}/checkout`, {
      method: 'POST',
    });
  }

  /**
   * Search for available resources (desks and conference rooms)
   */
  async searchResources(
    params?: ResourceSearchParams
  ): Promise<ApiResponse<{ items: Resource[]; size: number }>> {
    const queryParams = new URLSearchParams({
      start: '0',
      limit: String(params?.limit || 100),
    });

    if (params?.search) queryParams.append('search', params.search);
    if (params?.locationPath) queryParams.append('locationPath', params.locationPath);
    if (params?.locationId) queryParams.append('ancestorLocationId', params.locationId);
    if (params?.type && params.type !== 'all') {
      // Filter by resource type - desks typically have different type codes
      queryParams.append('type', params.type === 'desk' ? 'Desk' : 'Room');
    }

    return this.request(`/api/v3/reservation/resources?${queryParams}`);
  }

  /**
   * Get resource availability for a time range (legacy endpoint - may not work correctly)
   */
  async getResourceAvailability(
    resourceIds: string[],
    startAt: string,
    endAt: string
  ): Promise<ApiResponse<{ items: Array<{ resourceId: string; available: boolean; conflicts?: Reservation[] }> }>> {
    const queryParams = new URLSearchParams({
      resourceIds: resourceIds.join(','),
      startAt,
      endAt,
    });

    return this.request(`/api/v3/reservation/resources/availability?${queryParams}`);
  }

  /**
   * Get reservable resources with availability status using the correct Appspace API
   * This is the endpoint the Appspace UI actually uses
   */
  async getReservableResources(params: {
    floorIds?: string[];
    locationId?: string;
    startAt: string;
    endAt: string;
    types?: string[];
    minCapacity?: number;
    limit?: number;
  }): Promise<ApiResponse<{ items: Array<{
    id: string;
    name: string;
    type: string;
    subType?: string; // "VideoConferenceRoom", "HuddleSpace", "Desk", etc.
    capacity?: number;
    locationPath?: string;
    reservableStatus: string; // "Available", "Unavailable", or "Checkin"
  }>; size: number }>> {
    const body: Record<string, unknown> = {
      limit: params.limit || 1000,
      includeSourceObject: 'false',
      reservableStatus: ['available', 'unavailable', 'checkin'],
      types: params.types || ['room', 'space', 'poi', 'connectedResource'],
      startAt: params.startAt,
      endAt: params.endAt,
      isReservable: ['true', 'false'],
      page: 0,
    };
    if (params.minCapacity) body.minCapacity = params.minCapacity;
    if (params.floorIds) body.floorIds = params.floorIds;
    if (params.locationId) body.locationId = params.locationId;

    return this.request('/api/v3/reservation/resources/reservable', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /**
   * Get floors for a location/building
   */
  async getFloors(networkId: string): Promise<ApiResponse<{ items: Array<{
    id: string;
    name: string;
    type: string;
  }>; size: number }>> {
    const queryParams = new URLSearchParams({
      sort: 'name',
      networkid: networkId,
      includesourceobject: 'true',
      currentstatus: 'Active',
      types: 'floor',
      start: '0',
      page: '1',
      limit: '200',
      pagecount: '200',
    });

    return this.request(`/api/v3/reservation/resources?${queryParams}`);
  }

  /**
   * Search for available resources in a time slot
   */
  async findAvailableResources(params: {
    startAt: string;
    endAt: string;
    type?: 'desk' | 'room';
    locationPath?: string;
    capacity?: number;
    limit?: number;
  }): Promise<ApiResponse<{ items: Resource[]; size: number }>> {
    const queryParams = new URLSearchParams({
      startAt: params.startAt,
      endAt: params.endAt,
      start: '0',
      limit: String(params.limit || 50),
      available: 'true',
    });

    if (params.locationPath) queryParams.append('locationPath', params.locationPath);
    if (params.capacity) queryParams.append('capacity', String(params.capacity));
    if (params.type) queryParams.append('type', params.type === 'desk' ? 'Desk' : 'Room');

    return this.request(`/api/v3/reservation/resources?${queryParams}`);
  }

  /**
   * Get resource details by ID
   */
  async getResource(resourceId: string): Promise<ApiResponse<Resource>> {
    return this.request(`/api/v3/reservation/resources/${resourceId}`);
  }

  /**
   * Get resource by name (using search)
   */
  async getResourceByName(name: string): Promise<ApiResponse<Resource | null>> {
    const result = await this.searchResources({ search: name, limit: 10 });
    
    if (!result.success) {
      return { success: false, error: result.error };
    }

    const exactMatch = result.data?.items.find(
      (r) => r.name.toLowerCase() === name.toLowerCase()
    );

    return { success: true, data: exactMatch || null };
  }
}

/**
 * Helper to format date for Appspace API
 */
export function formatDateTime(date: Date | string, time?: string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  
  if (time) {
    const [hours, minutes] = time.split(':');
    d.setHours(parseInt(hours, 10), parseInt(minutes, 10), 0, 0);
  }
  
  return d.toISOString();
}

/**
 * Get timezone offset in hours for common US timezones
 * Returns offset to ADD to local time to get UTC
 */
function getTimezoneOffsetHours(timezone: string, date: Date): number {
  // Simplified timezone handling for common US timezones
  // TODO: Use a proper timezone library for full support
  const month = date.getMonth(); // 0-11
  
  // Approximate DST: March (2) to November (10) in the US
  const isDST = month >= 2 && month < 10;
  
  switch (timezone) {
    case 'America/New_York':
    case 'Eastern Standard Time':
    case 'EST':
      return isDST ? 4 : 5; // EDT = UTC-4, EST = UTC-5
    case 'America/Chicago':
    case 'Central Standard Time':
    case 'CST':
      return isDST ? 5 : 6;
    case 'America/Denver':
    case 'Mountain Standard Time':
    case 'MST':
      return isDST ? 6 : 7;
    case 'America/Los_Angeles':
    case 'Pacific Standard Time':
    case 'PST':
      return isDST ? 7 : 8;
    default:
      return 5; // Default to EST
  }
}

/**
 * Helper to create date range for a full day
 */
export function getFullDayRange(
  date: string,
  startTime = '09:00',
  endTime = '17:00',
  timezone = 'America/New_York'
): { startAt: string; endAt: string } {
  const [year, month, day] = date.split('-').map(Number);
  const [startHour, startMin] = startTime.split(':').map(Number);
  const [endHour, endMin] = endTime.split(':').map(Number);
  
  // Create a reference date to determine DST
  const refDate = new Date(year, month - 1, day);
  const offsetHours = getTimezoneOffsetHours(timezone, refDate);
  
  // Create UTC times by adding the timezone offset
  // e.g., 12:00 EST + 5 hours = 17:00 UTC
  const startAt = new Date(Date.UTC(year, month - 1, day, startHour + offsetHours, startMin, 0, 0));
  const endAt = new Date(Date.UTC(year, month - 1, day, endHour + offsetHours, endMin, 0, 0));
  
  return {
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
  };
}



