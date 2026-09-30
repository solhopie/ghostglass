/**
 * GhostGlass visual replay — entry point.
 *
 * /runs/<id> boots the replay for one run. / shows a run picker.
 * Everything is local: same-origin API, no external requests, no telemetry.
 */
import { getEventsPage, getGraph, getRunDetail, getRuns, getTimeline } from "./api.js";
import { el, text } from "./format.js";
import { Store } from "./store.js";
import { GraphView } from "./graphView.js";
import { HeaderView } from "./headerView.js";
import { InspectorView } from "./inspectorView.js";
import { StreamView } from "./streamView.js";
import { TimelineView } from "./timelineView.js";

function bootOverlay(message: string): HTMLElement {
  const app = document.getElementById("app") as HTMLElement;
  app.innerHTML = "";
  const overlay = el("div", "boot");
  const mark = el("div", "boot-mark");
  const msg = el("div", "boot-msg");
  text(msg, message);
  overlay.appendChild(mark);
  overlay.appendChild(msg);
  app.appendChild(overlay);
  return overlay;
}

function fail(message: string): void {
  const overlay = bootOverlay("");
  overlay.innerHTML = "";
  const msg = el("div", "boot-msg boot-error");
  text(msg, message);
  overlay.appendChild(msg);
}

async function bootPicker(): Promise<void> {
  const overlay = bootOverlay("Loading runs…");
  try {
    const { runs } = await getRuns();
    overlay.innerHTML = "";
    const wrap = el("div", "picker");
    const h = el("h1", "picker-title");
    text(h, "GhostGlass");
    const sub = el("div", "picker-sub");
    text(sub, "Saved traces on this machine");
    wrap.appendChild(h);
    wrap.appendChild(sub);
    if (runs.length === 0) {
      const empty = el("div", "picker-empty");
      text(empty, "No saved runs yet. Record one with: ghostglass run -- <command>");
      wrap.appendChild(empty);
    }
    for (const r of runs) {
      const a = document.createElement("a");
      a.className = "picker-row";
      a.href = `/runs/${r.runId}`;
      const cmd = el("div", "picker-cmd");
      text(cmd, r.commandLine);
      const meta = el("div", "picker-meta");
      text(
        meta,
        `${r.runId} · ${new Date(r.startTime).toLocaleString()} · ${r.eventCount.toLocaleString()} events` +
          (r.interrupted ? " · interrupted" : ""),
      );
      a.appendChild(cmd);
      a.appendChild(meta);
      wrap.appendChild(a);
    }
    overlay.appendChild(wrap);
  } catch (err) {
    fail(`Could not load runs: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function bootRun(runId: string): Promise<void> {
  const app = document.getElementById("app") as HTMLElement;
  app.innerHTML = "";

  const header = el("header", "gg-header");
  const main = el("main", "gg-main");
  const graphSection = el("section", "gg-graph");
  const side = el("aside", "gg-side");
  const streamHost = el("div", "gg-stream");
  const inspectorHost = el("div", "gg-inspector");
  side.appendChild(streamHost);
  side.appendChild(inspectorHost);
  main.appendChild(graphSection);
  main.appendChild(side);
  const footer = el("footer", "gg-timeline");
  app.appendChild(header);
  app.appendChild(main);
  app.appendChild(footer);

  const store = new Store(runId);
  const headerView = new HeaderView(header, store);
  const graphView = new GraphView(graphSection, store);
  const streamView = new StreamView(streamHost, store);
  const inspectorView = new InspectorView(inspectorHost, store);
  const timelineView = new TimelineView(footer, store);
  void graphView;
  void inspectorView;

  headerView.render();
  streamView.render();
  timelineView.render();

  try {
    const [detail, graph, timeline] = await Promise.all([
      getRunDetail(runId),
      getGraph(runId),
      getTimeline(runId),
    ]);
    store.setRunData(detail.metadata, detail.summary, graph);
    store.setTimeline(timeline.startTimeMs, timeline.timestamps);
    headerView.render();
    graphView.render();
    inspectorView.render();
    timelineView.render();
    // Stream events in the background; replay works off the timeline immediately.
    await streamView.loadAll(runId, (offset, limit) => getEventsPage(runId, offset, limit));
  } catch (err) {
    fail(`Could not load run ${runId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const match = window.location.pathname.match(/^\/runs\/([^/]+)$/);
if (match?.[1]) {
  void bootRun(decodeURIComponent(match[1]));
} else {
  void bootPicker();
}
