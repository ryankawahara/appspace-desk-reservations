# Appspace Reservations MCP Server

An MCP (Model Context Protocol) server that enables AI assistants to manage desk and conference room reservations through the Appspace API.

## Features

- 🪑 **Reserve Desks** - Book desks by name or resource ID
- 🚪 **Reserve Rooms** - Book conference rooms with specific times
- ❌ **Cancel Reservations** - Cancel existing bookings
- ✏️ **Modify Reservations** - Change dates, times, or resources
- 📋 **List Reservations** - View your upcoming bookings
- ✅ **Check In/Out** - Check in to or out of reservations
- 🔍 **Search Resources** - Find available desks and rooms

## Installation

```bash
cd mcp-server
npm install
npm run build
```

## Configuration

Set the following environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `APPSPACE_HOST` | No | Appspace API URL (defaults to `https://disney.cloud.appspace.com`) |
| `APPSPACE_TOKEN` | **Yes** | Your Appspace authentication token |
| `ORGANIZER_ID` | **Yes** | Your Appspace user ID |
| `ORGANIZER_NAME` | **Yes** | Your display name |
| `ORGANIZER_EMAIL` | **Yes** | Your email address |
| `TIMEZONE` | No | Timezone for bookings (defaults to `America/New_York`) |
| `BOOKING_START_TIME` | No | Default start time for desk reservations (defaults to `09:00`) |
| `BOOKING_END_TIME` | No | Default end time for desk reservations (defaults to `17:00`) |
| `DESK_LOOKUP_PATH` | No | Path to DESK_LOOKUP.json file |

### Getting Your Appspace Credentials

1. Log into Appspace in your browser
2. Open browser DevTools console (F12)
3. Run this script:

```javascript
const getUser = () => {
    const jwt = sessionStorage.jwt;
    const payload = JSON.parse(atob(jwt.split('.')[1]));
    return {
        token: payload.user.CurrentAccess.Token,
        userId: payload.user.UserId,
        email: payload.user.Username,
        name: payload.user.DisplayName
    };
};
console.log(JSON.stringify(getUser(), null, 2));
```

4. Use the output to set your environment variables

## Usage with Claude Desktop

Add to your Claude Desktop configuration (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "appspace-reservations": {
      "command": "node",
      "args": ["/path/to/appspace-desk-reservations/mcp-server/dist/index.js"],
      "env": {
        "APPSPACE_TOKEN": "your-token-here",
        "ORGANIZER_ID": "your-user-id",
        "ORGANIZER_NAME": "Your Name",
        "ORGANIZER_EMAIL": "your.email@example.com"
      }
    }
  }
}
```

## Usage with Cursor

Add to your Cursor MCP configuration (`.cursor/mcp.json` in your project or global config):

```json
{
  "mcpServers": {
    "appspace-reservations": {
      "command": "node",
      "args": ["/path/to/appspace-desk-reservations/mcp-server/dist/index.js"],
      "env": {
        "APPSPACE_TOKEN": "your-token-here",
        "ORGANIZER_ID": "your-user-id",
        "ORGANIZER_NAME": "Your Name",
        "ORGANIZER_EMAIL": "your.email@example.com"
      }
    }
  }
}
```

## Available Tools

### `reserve_desk`
Reserve a desk for a specific date and time with custom hours.

**Parameters:**
- `desk` (required): Desk name (e.g., "08W-125-H") or resource ID
- `date` (required): Date in YYYY-MM-DD format
- `startTime`: Start time in HH:MM format (default: 09:00)
- `endTime`: End time in HH:MM format (default: 17:00)
- `subject`: Reservation title

**Example:** "Reserve desk 08W-125-H for tomorrow from 10am to 3pm"

---

### `reserve_desk_day`
**Quick full-day reservation** - Reserve a desk for standard office hours (9am-5pm).

**Parameters:**
- `desk` (required): Desk name (e.g., "08W-125-H") or resource ID
- `date` (required): Date - can use "today", "tomorrow", "next monday", or YYYY-MM-DD format

**Examples:**
- "Book desk 08W-125-H for today"
- "Reserve my desk for tomorrow"
- "Book 08W-125-H for next wednesday"

---

### `reserve_desk_recurring`
**Auto-reserve your desk every week** - Just provide your desk name and it books all upcoming weekdays (Mon-Fri, 9am-5pm) for the next 7 days. Run weekly to stay booked.

**Parameters:**
- `desk` (required): Desk name or resource ID
- `days`: Which days to book (default: all weekdays). Example: `["monday", "wednesday", "friday"]`

**Examples:**
- "Reserve my desk for the week" → Books Mon-Fri for next 7 days
- "Auto-book desk 08W-125-H" → Same as above
- "Book my desk every Monday, Wednesday, Friday" → Only those days

---

### `reserve_room`
Reserve a conference room.

**Parameters:**
- `room` (required): Room name or resource ID
- `date` (required): Date in YYYY-MM-DD format
- `startTime` (required): Start time in HH:MM format
- `endTime` (required): End time in HH:MM format
- `subject`: Meeting title

**Example:** "Book conference room 08W-Large for Friday 2pm to 3pm"

---

### `cancel_reservation`
Cancel an existing reservation.

**Parameters:**
- `reservationId` (required): The reservation ID to cancel

**Example:** "Cancel my reservation abc123-def456"

---

### `modify_reservation`
Modify an existing reservation.

**Parameters:**
- `reservationId` (required): The reservation ID
- `date`: New date
- `startTime`: New start time
- `endTime`: New end time
- `resource`: New desk/room
- `subject`: New title

**Example:** "Move my reservation abc123 to Wednesday"

---

### `list_reservations`
List your reservations.

**Parameters:**
- `startDate`: Start of date range (default: today)
- `endDate`: End of date range (default: 7 days from start)
- `status`: Filter by status (all, active, pending, confirmed)

**Example:** "Show my reservations for next week"

---

### `check_in`
Check in to a reservation.

**Parameters:**
- `reservationId`: Specific reservation to check in to (optional)

**Example:** "Check me in to my desk reservation"

---

### `check_out`
Early checkout from a reservation.

**Parameters:**
- `reservationId` (required): Reservation to check out from

---

### `check_meeting_availability`
Check availability of conference rooms and huddle spaces by floor. Includes a text-based floor map by default.

**Parameters:**
- `floor`: Floor shortcut (e.g., "8", "8W", "8E"). Auto-detected from your desk reservation if not provided.
- `date`: Date to check (YYYY-MM-DD, "today", "tomorrow"). Defaults to today.
- `startTime` (required): Start time in HH:MM format
- `duration`: Meeting duration in minutes (e.g., 30, 60, 90). Use this OR endTime.
- `endTime`: End time in HH:MM format. Use this OR duration.
- `resources`: Array of specific resource names or IDs
- `location`: Full location prefix to match
- `skipMap`: Skip generating the ASCII floor map (default: false)

**Floor Shortcuts:**
| Shortcut | Matches |
|----------|---------|
| `8` | All floor 8 rooms (8E + 8W) |
| `8W` | Floor 8 West rooms only |
| `8E` | Floor 8 East rooms only |
| `9`, `9W`, `9E` | Floor 9 rooms |
| `7`, `7W`, `7E` | Floor 7 rooms |
| etc. | Floors 4-17 supported |

**Examples:**
- "What rooms are available on 8W at 3pm today?"
- "Check availability for floor 8 from 2-3pm tomorrow"
- "Are any 9E conference rooms free at 10am?"
- "Find a huddle room for a 30-minute meeting at 2pm"

---

### `batch_check_availability`
Check meeting room availability across multiple days and times in a single call. Returns a summary table showing availability patterns.

**Parameters:**
- `floor`: Floor shortcut (e.g., "8W"). Auto-detected if not provided.
- `dates`: Array of dates to check (YYYY-MM-DD). Defaults to next 5 weekdays.
- `times`: Array of start times (HH:MM). Defaults to hourly 9am-5pm.
- `duration`: Meeting duration in minutes (default: 30)

**Examples:**
- "Show me room availability for next week"
- "What's the availability like on 8W this week?"

---

### `get_availability_stats`
Generate visual text-based charts showing meeting room availability patterns. Shows heatmaps, bar charts, and recommendations. Excludes Fridays by default.

**Parameters:**
- `floor`: Floor shortcut (e.g., "8W"). Auto-detected if not provided.
- `duration`: Meeting duration in minutes (default: 30)
- `includeFriday`: Include Friday in stats (default: false)

**Examples:**
- "Show me availability stats for next week"
- "What are the best times to book meetings?"
- "Room availability heatmap for floor 8"

---

### `search_resources`
Search for available desks or rooms.

**Parameters:**
- `type`: "desk", "room", or "all"
- `search`: Search query
- `location`: Location filter
- `date`: Date to check availability
- `startTime`: Start time for availability
- `endTime`: End time for availability
- `capacity`: Minimum room capacity

**Example:** "Find available conference rooms on the 8th floor"

---

### `get_resource_info`
Get details about a specific desk or room.

**Parameters:**
- `resource` (required): Resource name or ID

**Example:** "What amenities does room 08W-Large have?"

## Desk Lookup File

Place a `DESK_LOOKUP.json` file in the project root or mcp-server directory to enable desk name resolution:

```json
{
  "08W-125-H": "4287c413-3c0a-4f9d-8865-ed80e54ff82d",
  "08W-125-J": "9178b379-0a24-4a2b-acb0-b819e71a7445"
}
```

See the main project README for instructions on generating this file.

## Room Configuration

The `ROOM_CONFIG.json` file defines floor shortcuts for conference room lookups. It maps shortcuts like "8W" to the full room naming pattern "08W".

```json
{
  "building": {
    "name": "7 Hudson Square",
    "prefix": "!CR NYNY 7 HUDSON"
  },
  "shortcuts": {
    "8": "08",
    "8E": "08E",
    "8W": "08W",
    "9": "09",
    "9E": "09E",
    "9W": "09W"
  }
}
```

This allows natural queries like "check availability on 8W" instead of needing the full room prefix.

## Development

```bash
# Watch mode for development
npm run dev

# Build for production
npm run build

# Run the server
npm start
```

## Troubleshooting

### "Missing required environment variables"
Ensure all required environment variables are set before starting the server.

### "Could not find desk/room"
- Check that the name matches exactly (case-sensitive without lookup file)
- Ensure DESK_LOOKUP.json exists and contains the resource
- Try using the resource UUID instead

### "Error creating reservation"
- Verify your token hasn't expired
- Check if the resource is available at the requested time
- Ensure the time format is correct (HH:MM, 24-hour)

## License

MIT

