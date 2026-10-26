# Monitor options

Fields inside `monitor` beyond `strategy` and `triggers[].{id, regex, literal}`:

- `triggers[].cooldownMs`: minimum ms between events from that trigger.
- `triggers[].threshold: { captureGroup, op: "lt" | "lte" | "gt" | "gte", value }`: fire only when the regex capture group, read as a number, passes the comparison. Needs `regex`.
- `throttle: { dedupeExactLine (default true), cooldownMs }`: skip repeated identical lines; global cooldown across triggers.
- `persistence: { stopAfterFirstEvent, maxEvents }`: stop the monitor after the first or Nth event.
- `poll: { intervalMs (default 5000) }`: rerun interval for `poll-diff`.
- `fileWatch: { path, recursive, events: ["rename", "change"] }`: for `file-watch`; omit `command` and `spawn`.
- `detector: { detectorCommand, timeoutMs (default 3000) }`: a command that receives each candidate event as JSON on stdin and prints a JSON decision (boolean or object) on stdout.

Event history: `{ monitorEvents: true, monitorSessionId, monitorEventLimit (20), monitorEventOffset (newest to skip, 0), monitorSinceEventId, monitorTriggerId }`.
