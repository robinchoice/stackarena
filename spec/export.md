# Export and import

Settings offers export as JSON or CSV and import of both. Files are written and read through the
platform's file dialog; on the web that is a download and a file input.

## JSON

The full backup. `Habit` and `CheckIn` are exactly the schemas in `openapi.yaml`.

```json
{
  "format": "stackarena-habits",
  "version": 1,
  "exportedAt": "2026-10-06T16:04:00.000Z",
  "habits": [],
  "checkins": []
}
```

- `habits` holds all habits including archived ones.
- `checkins` holds every check-in with a count above 0. Check-ins with count 0 may be left out.
- File name: `habits-YYYY-MM-DD.json` with the export date.

## CSV

For spreadsheets, and enough to restore habits and check-ins. UTF-8 without BOM, comma separated,
line ends `\n`, quoting per RFC 4180, one header row. File name: `habits-YYYY-MM-DD.csv`.

One row per check-in with a count above 0. A habit without such check-ins gets one row with empty
`date` and `count`. Rows are sorted like the habits (by `created_at`, then `habit_id`), then by `date`.

| Column | Content |
|---|---|
| `habit_id` | UUID |
| `habit_name` | Name |
| `icon` | Icon name |
| `color` | 1 to 7 |
| `rhythm` | `daily`, `weekly` or `days` |
| `times_per_week` | Number for `weekly`, otherwise empty |
| `days` | Weekday numbers separated by spaces for `days` (e.g. `0 2 4`), otherwise empty |
| `target_per_day` | 1 to 20 |
| `reminder` | `HH:MM` or empty |
| `created_at` | RFC 3339 |
| `archived_at` | RFC 3339 or empty |
| `date` | `YYYY-MM-DD` or empty |
| `count` | 1 to 99 or empty |

## Import

- JSON: every habit and check-in in the file is merged with last-write-wins, exactly like a sync
  (see `openapi.yaml`). Newer local changes therefore survive an import of an older file.
- CSV: the first row of each `habit_id` defines the habit. Imported habits and check-ins get the
  import time as `updatedAt` and the importing device as `deviceId`, so they win against local data.
- Imported data reaches the server with the next sync.
- A file that does not match the format changes nothing. The app shows an error message instead.
- After a successful import the app shows a confirmation with the number of imported habits.
