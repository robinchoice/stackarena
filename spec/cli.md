# CLI

Only for teams whose stack includes a command line interface on their client core. The CLI works on
the same local data and rules as the apps, so the organisers can check the core without a UI. The
result is shown next to the contest and does not count towards the score.

## Calling it

- `clients/<team>/cli.sh <command> [arguments]` builds the CLI if needed and runs it.
- `STACKARENA_HOME`: directory with the local data of one device (token, cursor, device id,
  habits, check-ins). Two directories are two devices.
- `STACKARENA_API_URL`: backend address, read when the CLI runs.
- Today is the local date in the time zone of the process (`TZ`).
- Every command except `login` and `sync` works offline on the local data.
- Commands that print something print exactly one JSON object on stdout. Errors end with a non-zero
  exit code and a message on stderr and change nothing.

## Commands

| Command | Effect | Output |
|---|---|---|
| `login <email> <password>` | Starts a session and keeps the token | anything |
| `sync` | Pushes local changes and pulls until `hasMore` is false (`openapi.yaml`). Without a connection it fails and keeps the local changes | anything |
| `today` | | `Today` |
| `show <id>` | | `HabitState` |
| `stats` | | `Stats` |
| `check <id> <count>` | Sets today's count of the habit (0 to 99) | `HabitState` |
| `add <json>` | Creates a habit from `name`, `icon`, `color`, `rhythm`, `targetPerDay` and `reminder` | `Habit` |
| `edit <id> <json>` | Changes the given fields of the same list | `Habit` |
| `archive <id>` | Archives the habit | `Habit` |
| `export <file>` | Writes JSON or CSV after the file extension (`export.md`) | anything |
| `import <file>` | Imports JSON or CSV after the file extension (`export.md`) | `{ "habits": <number of imported habits> }` |

`Habit` is the schema in `openapi.yaml`. Changes get the current time as `updatedAt` and the
device id of `STACKARENA_HOME`, like changes in the apps.

## Output

Values follow `rules.md`; rates are whole percent.

```jsonc
// Today: the due habits that are not archived, ordered like the habits
{
  "today": "2026-10-25",
  "progress": { "done": 3, "due": 6 },
  "habits": [{ "id": "…", "name": "Drink water", "count": 3, "targetPerDay": 8, "done": false }]
}

// HabitState
{
  "id": "…",
  "name": "Drink water",
  "archived": false,
  "dueToday": true,
  "countToday": 3,
  "doneToday": false,
  "currentStreak": 12,
  "longestStreak": 13,
  "rate30": 74
}

// Stats: rate of this week, this month and the last 30 days per active habit, highest first,
// equal rates in habit order
{ "week": 84, "month": 75, "compare": [{ "id": "…", "rate": 100 }] }
```

## Check

From `harness/` after `bun install`:
`CLI=<path to cli.sh> BASE_URL=<backend url> bun test cli/`
