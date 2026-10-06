# Habit rules

Every client computes these values exactly as described here. The E2E suite compares what a client
shows with the expectations that `harness/seed` derives from the same rules.

## Days and weeks

- A day is a local calendar date (`YYYY-MM-DD`) in the device's time zone. Check-ins store this date.
- Weeks run from Monday to Sunday. Weekday numbers: 0 is Monday, 6 is Sunday.
- *Today* is the device's current local date.
- Language: German when the system language is German, otherwise English, until the user switches.
  The choice is remembered.

## Which days count

- A habit counts from the local date of its `createdAt` onwards. Earlier days are ignored everywhere.
- Archived habits (`archivedAt` is set) appear neither on Today nor in Statistics. Their history stays
  and comes back when the habit is restored.
- Habits are listed in the order of `createdAt`, then `id`.
- A day is **done** when its check-in count is at least `targetPerDay`.

## Due

| Rhythm | A day is due when |
|---|---|
| `daily` | always |
| `days` | its weekday is in `days` |
| `weekly` | its week has fewer than `timesPerWeek` done days, not counting the day itself |

Today shows every active habit that is due today. All other active habits appear under
“Not due today”. The progress on Today is the number of due habits that are done today, out of all
habits due today.

## Counting

- `targetPerDay` 1: the check button toggles today's count between 0 and 1.
- `targetPerDay` above 1: the stepper adds or removes one, within 0 to 99.
- Unchecking writes count 0; check-ins are never deleted.

## Streaks

- `daily` and `days`: walk back from today one day at a time. If today is not done yet, start
  yesterday instead. Skip days that are not due. Count done days until the first due day that is
  not done, or until the habit's first day.
- `weekly`: count weeks with at least `timesPerWeek` done days, walking back from the current week.
  If the current week has not reached that yet, start with the previous week.
- The longest streak is the longest such run anywhere in the history. An unfinished today or current
  week never ends a run. The longest streak is never shorter than the current one.
- Units: days for `daily`, weeks for `weekly`, times for `days`.

## Rates

For a period from day A to day B (B is today at the latest), only days from the habit's first day on:

- `daily` and `days`: every due day contributes `min(1, count / targetPerDay)`. The rate is the sum
  divided by the number of due days.
- `weekly`: `expected = timesPerWeek × (number of days in the period) / 7`. The rate is
  `min(done days, expected) / expected`.
- Several habits: add up the contributions and the due units (due days or `expected`) of all active
  habits, then divide.
- No due units: the rate is 0.
- Percentages are rounded half up to whole numbers.

Where rates appear:

| Place | Period |
|---|---|
| Habit details, rate | the last 30 days: today minus 29 days up to today |
| Habit details and Statistics, chart by weeks | each of the last 12 weeks including the current one, which ends today |
| Habit details and Statistics, chart by months | each of the last 12 calendar months including the current one, which ends today |
| Statistics, big number | the current week (weeks) or the current month (months), up to today |
| Statistics, comparison | each active habit over the last 30 days, highest rate first |

## Heatmap

53 columns of weeks, Monday on top, the current week on the right. A cell shows the day's share of
`targetPerDay` in four steps (below 30 %, below 60 %, below 100 %, done). Days that are not due and
have no check-in stay empty. Days before the first day are not drawn.

## Reminders

On every due day that is not done yet, the reminder fires at the local time in `reminder`. Platform
rules: iOS, Android, macOS and Windows schedule through the system, so reminders also arrive while the
app is closed. On Linux the app may keep running in the tray with autostart for this. On the web
reminders only fire while the app is open.
