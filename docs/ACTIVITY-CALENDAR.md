# Activity Calendar Guide

GitHub-style contribution calendar for tracking user activity.

## Overview

The Activity Calendar API provides:
- Daily activity tracking (posts, articles, comments, etc.)
- GitHub-style contribution heatmap
- Streak calculation (current and longest)
- Year-based filtering
- Contribution level visualization (0-3)

## Endpoints

### Get Activity Heatmap

**GET** `/api/users/{userId}/activity`

Get activity heatmap data for a user.

**Parameters:**
- `userId` (path) - User ID (UUID)
- `year` (query, optional) - Year to view (default: last 365 days)

**Examples:**

```bash
# Default view (last 365 days)
curl http://localhost:3000/api/users/{userId}/activity

# Specific year
curl "http://localhost:3000/api/users/{userId}/activity?year=2024"
```

**Response:**
```json
{
  "days": [
    {
      "date": "2024-01-01",
      "activityCount": 5,
      "isActive": true,
      "level": 2,
      "breakdown": {
        "posts": 2,
        "articles": 0,
        "comments": 3,
        "forumQuestions": 0,
        "forumAnswers": 0,
        "likes": 0,
        "messages": 0
      }
    },
    {
      "date": "2024-01-02",
      "activityCount": 0,
      "isActive": false,
      "level": 0
    },
    ...
  ],
  "stats": {
    "totalContributions": 487,
    "currentStreak": 12,
    "longestStreak": 45,
    "contributionLevels": {
      "level0": 150,
      "level1": 100,
      "level2": 80,
      "level3": 35
    }
  }
}
```

### Get Available Years

**GET** `/api/users/{userId}/activity/years`

Get list of years available for activity calendar.

**Parameters:**
- `userId` (path) - User ID (UUID)

**Response:**
```json
{
  "years": [2023, 2024, 2025],
  "joinedYear": 2023
}
```

## Date Range Logic

### Default View (No Year Parameter)

- Shows **last 365 days** from today
- Rolling window (updates daily)
- Respects user's joined date (never shows before `createdAt`)
- Never shows future dates

**Example:**
- Today: Dec 3, 2025
- Joined: Oct 15, 2023
- Range: Dec 4, 2024 to Dec 3, 2025 (365 days)

### Year View (Year Parameter Provided)

- Shows **Jan 1 to Dec 31** of specified year
- Respects user's joined date (starts from join date if year is join year)
- Never shows future dates (ends at today if current year)

**Examples:**

1. **Full Year (Past Year)**
   - Year: 2024
   - Joined: Oct 15, 2023
   - Range: Jan 1, 2024 to Dec 31, 2024 (366 days - leap year)

2. **Partial Year (Join Year)**
   - Year: 2023
   - Joined: Oct 15, 2023
   - Range: Oct 15, 2023 to Dec 31, 2023 (78 days)

3. **Current Year (Partial)**
   - Year: 2025
   - Today: Dec 3, 2025
   - Range: Jan 1, 2025 to Dec 3, 2025 (337 days)

4. **Year Before Join**
   - Year: 2022
   - Joined: Oct 15, 2023
   - Response: Empty array `[]`

## Contribution Levels

Each day has a `level` field (0-3) for color coding:

| Level | Contributions | Color | Description |
|-------|--------------|-------|-------------|
| 0 | 0 | Gray | No activity |
| 1 | 1-3 | Light Green | Low activity |
| 2 | 4-9 | Medium Green | Moderate activity |
| 3 | 10+ | Dark Green | High activity |

**Calculation:**
```typescript
if (activityCount === 0) return 0;
if (activityCount >= 1 && activityCount <= 3) return 1;
if (activityCount >= 4 && activityCount <= 9) return 2;
return 3; // 10+
```

## Activity Breakdown

Each active day includes a `breakdown` object:

```json
{
  "posts": 2,
  "articles": 0,
  "comments": 3,
  "forumQuestions": 0,
  "forumAnswers": 0,
  "likes": 0,
  "messages": 0
}
```

**Activity Count = Sum of all fields**

## Stats

### Total Contributions

Sum of all `activityCount` values in the date range.

### Current Streak

Consecutive days with activity ending today (or yesterday if no activity today).

**Calculation:**
- Start from today (or yesterday)
- Count backwards until a day with no activity
- Includes today if active

**Example:**
- Today: Dec 3, 2025 (5 contributions)
- Dec 2: 3 contributions
- Dec 1: 2 contributions
- Nov 30: 0 contributions
- **Current Streak: 3 days**

### Longest Streak

Best consecutive days streak ever achieved (all-time).

**Example:**
- Best period: Jan 1-45, 2024 (45 consecutive days)
- **Longest Streak: 45 days**

### Contribution Levels Distribution

Count of days in each level:

```json
{
  "level0": 150,  // 150 days with 0 contributions
  "level1": 100,  // 100 days with 1-3 contributions
  "level2": 80,   // 80 days with 4-9 contributions
  "level3": 35    // 35 days with 10+ contributions
}
```

**Total days = sum of all levels**

## Frontend Integration

### Calendar Grid

Render a 7×52 grid (or 7×53 for leap years):

```typescript
// Get activity data
const { days, stats } = await fetchActivity(userId, year);

// Group by week
const weeks = [];
for (let i = 0; i < days.length; i += 7) {
  weeks.push(days.slice(i, i + 7));
}

// Render grid
weeks.map((week, weekIndex) => (
  <div key={weekIndex} className="week">
    {week.map((day, dayIndex) => (
      <div
        key={day.date}
        className={`day level-${day.level}`}
        title={`${day.date}: ${day.activityCount} contributions`}
      />
    ))}
  </div>
));
```

### Color Coding

```css
.day.level-0 { background-color: #ebedf0; } /* Gray */
.day.level-1 { background-color: #9be9a8; } /* Light Green */
.day.level-2 { background-color: #40c463; } /* Medium Green */
.day.level-3 { background-color: #30a14e; } /* Dark Green */
```

### Year Selector

```typescript
// Get available years
const { years, joinedYear } = await fetchActivityYears(userId);

// Render dropdown
<select onChange={(e) => setYear(parseInt(e.target.value))}>
  <option value="">Last 365 days</option>
  {years.map((year) => (
    <option key={year} value={year}>
      {year} {year === joinedYear && '(Joined)'}
    </option>
  ))}
</select>
```

## Edge Cases

### User Joined Today

- Default view: Only today (1 day)
- Year view: Only today if current year

### No Activity Ever

- All days have `activityCount: 0`, `level: 0`
- `totalContributions: 0`
- `currentStreak: 0`
- `longestStreak: 0`

### Year Before Join

- Returns empty array `[]`
- Stats all zeros

### Future Year

- Returns `400 Bad Request`
- Error: "Invalid year: cannot be in the future"

### Leap Year

- Feb 29 handled correctly
- Year view shows 366 days for leap years

## Validation

### Year Parameter

- Must be integer
- Must be >= user's joined year
- Must be <= current year
- Returns `400` if invalid

### User ID

- Must be valid UUID
- Returns `404` if user not found

## Examples

### Complete Workflow

```typescript
// 1. Get available years
const { years, joinedYear } = await fetch('/api/users/{userId}/activity/years')
  .then(r => r.json());

// 2. Get activity for specific year
const { days, stats } = await fetch(`/api/users/{userId}/activity?year=2024`)
  .then(r => r.json());

// 3. Render calendar
renderCalendar(days, stats);

// 4. Show stats
displayStats(stats);
```

### Filtering by Activity Type

```typescript
// Get days with posts
const daysWithPosts = days.filter(day => 
  day.breakdown?.posts > 0
);

// Get days with high activity (level 3)
const highActivityDays = days.filter(day => 
  day.level === 3
);
```

## Best Practices

1. **Cache Activity Data**
   - Activity changes once per day
   - Cache for 24 hours
   - Invalidate on new activity

2. **Lazy Load Years**
   - Load default view first
   - Load year data on demand
   - Prefetch adjacent years

3. **Optimize Rendering**
   - Virtual scrolling for large grids
   - Render visible weeks only
   - Use CSS for colors (not inline styles)

4. **User Experience**
   - Show loading skeleton
   - Display stats prominently
   - Tooltip on hover (date + count)
   - Highlight current streak

## Next Steps

- [Profile API Guide](PROFILE-API.md)
- [Media Upload Guide](MEDIA-UPLOAD.md)

