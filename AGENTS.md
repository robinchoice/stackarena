# Stackarena

## Zweck & Links

Wettbewerb: Agents bauen denselben Habit-Tracker (`spec/`) auf verschiedenen Stacks
(`orchestrator/teams.json`), jeder Lauf in einem abgeschotteten Container. Ergebnisse liegen in
`results/runs/<id>/summary.json`, die Repos der Teams in `runs/<id>/` (beides gitignoriert).

## Checks

Kein Test-Setup für den Orchestrator. Nach Änderungen an `run.ts` einen Smoke-Lauf:
`bun orchestrator/run.ts --team backend/bun --run <n> --smoke`.

## Deploy

Kein Deploy. Nachtläufe startet der User-Timer `stackarena-night.timer` (21:00–00:00 alle 15 min),
eingerichtet mit `systemctl --user link orchestrator/stackarena-night.{service,timer}` und
`systemctl --user enable --now stackarena-night.timer`. Log: `journalctl --user -u stackarena-night`,
laufender Lauf: `journalctl --user -fu stackarena-<id>`.

## Fallen

- Läufe nutzen das Claude-Abo von Robin (`CLAUDE_STACKARENA_TOKEN`) und teilen sich das 5h-Limit mit
  ihm. Deshalb enden Nachtläufe spätestens um 04:00, und `night.ts` startet nur, wenn 20 Minuten lang
  keine Claude- oder Codex-Session aktiv war.
- `run.ts` liest den Stand von `HEAD` (`git archive`), uncommittete Änderungen an `spec/` und
  `harness/` gehen nicht in den Lauf.
- Ein abgebrochener Lauf blockiert seine ID: `runs/<id>` und `results/runs/<id>` nach
  `results/aborted/` verschieben, bevor er neu startet.
