# Stackarena

## Zweck & Links

Wettbewerb: Agents bauen denselben Habit-Tracker (`spec/`) auf verschiedenen Stacks
(`orchestrator/teams.json`), jeder Lauf in einem abgeschotteten Container. Ergebnisse liegen in
`results/runs/<id>/summary.json`, die Repos der Teams in `runs/<id>/` (beides gitignoriert).
Öffentliche Beschreibung und Ergebnistabelle für technische Leser: `README.md` (englisch), Lizenz MIT.

Bewertung: Nach jedem Lauf bewertet `orchestrator/grade.ts` unabhängig vom Agenten, mit dem letzten
Commit des Teams, unverändertem `spec/` und `harness/` der Quellrevision, frischer Datenbank bzw.
Referenz-API und ohne Zugangsdaten. Teilnoten unter `grade.parts`, je bestanden / (bestanden +
fehlgeschlagen); `score` ist ihr ungewichtetes Mittel. Backends (`start.sh`): `api` (`bun test api/`),
`contract` (Schemathesis wie `harness/api/contract.sh`, feste Seed, je Testfall) und `load` (k6 mit
`harness/load/sync.js`, je Check, dazu p95 je Request und Requests/s als Info). Clients
(`serve-web.sh`): `e2e`, eine vorhandene `cli.sh` als Info. Der Container hat kein Docker, deshalb
lädt das Skript Schemathesis (über uv) und k6 in festen Versionen aus `grade.ts` selbst.
Logs und Reports in `results/runs/<id>/grade/`.
Einen fertigen Lauf neu bewerten: `bun orchestrator/grade.ts --run <id>` (überschreibt `score` und
`grade`).

Dazu die Info-Spalte „Decompilation“ für Client-Teams: `orchestrator/decompile.ts` nimmt das
ausgelieferte Build eines Teams ohne Quelltext auseinander und schreibt die Trefferquote nach
`results/runs/<id>/decompilation.json`. Sie zählt nicht zur Bewertung.

Ebenso die Info-Spalte „CLI“ für Teams mit einer CLI auf ihrem Core (bisher `client/rust-core`):
Vertrag in `spec/cli.md`, Prüfung mit `harness/cli/` gegen die Regel-Referenz, Sync und Export:
`cd harness && CLI=<repo des laufs>/clients/<slug>/cli.sh BASE_URL=<backend> bun test cli/`.

## Checks

`bun test orchestrator/` prüft Fehlerpfade, Herkunftsrevision und Budget mit isolierten
Prozess-Fixtures, ohne Docker oder Modellaufrufe. `cd harness && bun run verify` prüft
Typen, Referenz-Backend und Mockup auf Desktop und Handy; echte Client-Szenarien bleiben dabei aus.
Nach Änderungen an `run.ts` zusätzlich einen Smoke-Lauf:
`bun orchestrator/run.ts --team backend/bun --run <n> --smoke` (bewertet sich mit `score` 0 und
`error: "no start.sh"`), nach Änderungen an `grade.ts` zusätzlich eine echte Neubewertung,
etwa `bun orchestrator/grade.ts --run backend-go-1` (gut 4 min). Nach Änderungen an `decompile.ts`
oder `questions.ts` einen auf dem Mockup-Build: `bun orchestrator/decompile.ts --smoke --run <n>`
(unter 1 min, 0,34 $, erwartet werden 6 von 6 Antworten). Nach Änderungen an `spec/` oder `harness/`:
`cd harness && bun run verify` (prüft API- und CLI-Tests gegen die Referenzen in `harness/reference`
und die UI-Szenarien gegen das Mockup).

Nach Änderungen am `orchestrator/Dockerfile` das Image mit neuem Tag bauen
(`docker build -t stackarena-run:<n> orchestrator`) und den Tag in `compose.yaml` und `decompile.ts`
nachziehen.

## Decompilation-Spalte

`bun orchestrator/decompile.ts --run client-<slug>-1`, am besten als eigene User-Unit wie ein
Wettbewerbslauf. Zwei Schritte, Abrechnung und Modell wie im Wettbewerb (`claude-opus-5-5`, Effort
`high`), festes Budget je Agent: 30 min / 5 $ für das Packen, 45 min / 5 $ für jede Analyse.
Der kumulierte Listenpreis umfasst API und Abo einschließlich Rückfall. Der Host prüft ihn
alle zwei Sekunden anhand der Session-Logs und stoppt den Container bei Erreichen des Budgets;
eine bereits laufende Anfrage und verzögerte Nutzungsdaten können die Grenze überschreiten.
`budgetExceeded` kennzeichnet das erreichte Budget; ein deshalb abgebrochener Lauf bekommt
`outcome: "budget_limit"`. Ein bereits erfolgreich abgeschlossener Lauf behält `success`.

1. Ein Agent mit Quelltext baut im Wettbewerbs-Image Web- und Linux-Ziel so, wie Nutzer sie bekommen
   (`orchestrator/pack.md`), und legt nur das Ausgelieferte nach `runs/<id>-decompile/out/<ziel>`.
   Als Backend-Adresse bekommt der Build eine Einweg-URL, die sonst nirgends vorkommt.
2. Je Ziel ein Agent ohne Quelltext im Image `stackarena-rea:1` (`orchestrator/rea.Dockerfile`, baut
   auf `rea-ghidra` aus `~/dev/rea/rea-tooling`, dazu REA-Skill, wabt, Prettier) beantwortet die
   sechs festen Fragen aus `orchestrator/questions.ts` (Backend-Adresse, aufgerufene Endpoints,
   Streak-Regel, Rundung der Quote, Heatmap, deutsche Texte). Bewertet wird mechanisch gegen `spec/`,
   kein Agent bewertet einen anderen.

`decompilation.json` hält je Ziel Trefferquote, Einzelnoten, Antworten mit Belegen, Werkzeuge, Zeit,
Tokens und Kosten. Eigene Builds kommen nicht ins Repo Mirksen/rea: dort stehen nur fremde Apps.

## Deploy

Kein Deploy. Nachtläufe startet der User-Timer `stackarena-night.timer` (01:30–02:15 alle 15 min,
nach der Savor-Nachtschicht ab 00:00, die bis etwa 01:30 dauert), eingerichtet mit
`systemctl --user link orchestrator/stackarena-night.{service,timer}` und
`systemctl --user enable --now stackarena-night.timer`, nach Änderungen
`systemctl --user daemon-reload`. Der Start um 01:30 bekommt 3,25 h, spätere entsprechend weniger,
jeder Lauf endet gegen 04:45. `night.ts` zählt einen Start erst, wenn die Unit nach einer Minute noch
läuft, sonst versucht es nach 30 s genau einmal neu und verschiebt Angelegtes nach `results/aborted/`,
damit das Team als Nächstes dran bleibt. Log: `journalctl --user -u stackarena-night`,
laufender Lauf: `journalctl --user -fu stackarena-<id>`.

## Fallen

- Steht `ANTHROPIC_STACKARENA_API_KEY` in `~/.secrets`, laufen die Agents mit diesem Key und
  verbrauchen das monatliche API-Guthaben des Max-Plans (200 $, verfällt zum Ende des
  Abrechnungszeitraums, geteilt mit dem Nacht-Review des Kontors über `ANTHROPIC_KONTOR_API_KEY`),
  nicht das Abo. `listPriceUsd` in `summary.json` ist dann echter Guthabenverbrauch, der erste volle
  Lauf (`backend-bun-1`, 89 min) kostete 25,57 $. Endet die Session mit
  einem API-Fehler (Guthaben aufgebraucht, Key abgelehnt), setzt `run.ts` sie mit dem Abo-Token fort
  (`billing: "api+subscription"`); `listPriceUsd` ist dann die Listenpreis-Summe beider Teile, der
  Guthabenverbrauch liegt darunter.
- Ohne Key oder nach dem Rückfall nutzen Läufe das Claude-Abo von Robin (`CLAUDE_STACKARENA_TOKEN`)
  und teilen sich das 5h-Limit mit ihm. Deshalb enden Nachtläufe spätestens um 05:00, und `night.ts`
  startet nur, wenn 20 Minuten lang keine Claude- oder Codex-Session aktiv war, die jemand begonnen
  hat. Sessions der Savor-Workflows zählen nicht, sie laufen fast die ganze Nacht: `night.ts` erkennt
  sie an `workflow` oder `unattended` in `~/dev/*/.savor/threads/*/thread.json`. Ebenso zählt ein
  Savor-Thread nicht, dessen letzte Eingabe (`inputAt`) älter als 20 Minuten ist, etwa ein Agent mit
  dem Auftrag, die Nacht durchzuarbeiten. Ändert Savor dieses Format, blockt jede Workflow-Session
  wieder den Start.
- `run.ts` liest den Stand von `HEAD` (`git archive`), uncommittete Änderungen an `spec/` und
  `harness/` gehen nicht in den Lauf. Nur die Referenz-API der Client-Läufe startet aus dem
  Arbeitsbaum (`compose.yaml` bindet `harness/` und `spec/` ein).
- Die Bewertung läuft nach dem Agenten in derselben Unit, höchstens 60 min (Installieren, Bauen,
  Tests; die Backends brauchten 4–13 min). Sie nutzt kein Modell, ein Nachtlauf belegt das Abo also
  nicht länger. Arbeitskopie `runs/<id>-grade` wird danach gelöscht.
- Ein abgebrochener Lauf blockiert seine ID: `runs/<id>` und `results/runs/<id>` nach
  `results/aborted/` verschieben, bevor er neu startet. Genauso blockiert eine fertige Analyse ihre
  ID über `runs/<id>-decompile`.
- `decompile.ts` liest den Smoke-Client aus `HEAD`, Änderungen an `orchestrator/decompile-smoke/`
  wirken erst nach dem Commit.
- Jeder Container braucht sein eigenes Docker-Netz: im Default-Bridge ist sein Resolver die
  Host-Adresse, und die sperrt `init.sh` zusammen mit dem restlichen Heimnetz (Fehlerbild
  `EAI_AGAIN` nach drei Minuten).
- Bewusst anders als der Skill `rea-sandbox`: Die Analyse-Container haben Internet, weil der Agent
  die API braucht. Die Ziele sind eigene Builds, keine fremden Apps. Gestartet wird keines
  (`decompile.md`), Heimnetz und Host bleiben gesperrt, und der Build liegt read-only unter
  `/work/input`.
