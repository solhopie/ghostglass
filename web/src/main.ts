/**
 * GhostGlass visual replay — entry point.
 *
 * /runs/<id> boots the replay for one run. / shows a run picker.
 * Everything is local: same-origin API, no external requests, no telemetry.
 */
import { getDiff, getEventsPage, getGraph, getHighlights, getRunDetail, getRuns, getTimeline } from "./api.js";
import { el, text } from "./format.js";
import { Store } from "./store.js";
import type { Highlight } from "./types.js";
import { DiffStore } from "./diffStore.js";
import { DiffGraphView } from "./diffGraphView.js";
import { DiffHeaderView } from "./diffHeaderView.js";
import { DiffInspectorView } from "./diffInspectorView.js";
import { DiffStreamView } from "./diffStreamView.js";
import { DiffTimelineView } from "./diffTimelineView.js";
import { GraphView } from "./graphView.js";
import { HeaderView } from "./headerView.js";
import { HighlightPanel } from "./highlightPanel.js";
import { InspectorView } from "./inspectorView.js";
import { LiveHeaderView } from "./liveHeaderView.js";
import { LiveStore } from "./liveStore.js";
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
  const highlightHost = el("div", "gg-highlights");
  side.appendChild(highlightHost);
  const highlightPanel = new HighlightPanel(highlightHost, store);
  void graphView;
  void inspectorView;

  headerView.render();
  streamView.render();
  timelineView.render();
  highlightPanel.render();

  try {
    const [detail, graph, timeline, hl] = await Promise.all([
      getRunDetail(runId),
      getGraph(runId),
      getTimeline(runId),
      getHighlights(runId).catch(() => ({ highlights: [] as Highlight[] })),
    ]);
    store.setRunData(detail.metadata, detail.summary, graph);
    store.setTimeline(timeline.startTimeMs, timeline.timestamps);
    store.setHighlights(hl.highlights);
    headerView.render();
    graphView.render();
    inspectorView.render();
    timelineView.render();
    highlightPanel.render();
    // Stream events in the background; replay works off the timeline immediately.
    await streamView.loadAll(runId, (offset, limit) => getEventsPage(runId, offset, limit));
  } catch (err) {
    fail(`Could not load run ${runId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Live Glass: stream a running command's trace into the viewer as it
 * happens. Same layout as the saved-run replay; when the backend reports a
 * terminal status the page becomes a normal replay with no reload.
 */
async function bootLive(runId: string): Promise<void> {
  document.title = `GhostGlass Live — ${runId}`;
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

  const store = new LiveStore(runId);
  const headerView = new LiveHeaderView(header, store);
  const graphView = new GraphView(graphSection, store);
  const streamView = new StreamView(streamHost, store);
  const inspectorView = new InspectorView(inspectorHost, store);
  const timelineView = new TimelineView(footer, store);
  const highlightHost = el("div", "gg-highlights");
  side.appendChild(highlightHost);
  const highlightPanel = new HighlightPanel(highlightHost, store);
  void graphView;
  void streamView;
  void inspectorView;
  void timelineView;

  headerView.render();
  streamView.render();
  timelineView.render();
  highlightPanel.render();

  try {
    await store.connect();
  } catch (err) {
    // The live session is gone (run finished and was unregistered, or the
    // watch process exited). If the completed run was saved, send the user
    // to its normal replay page instead of showing a dead live view.
    try {
      await getRunDetail(runId);
      window.location.replace(`/runs/${encodeURIComponent(runId)}`);
      return;
    } catch {
      // Not a saved run either — show the original error.
    }
    fail(`Could not start live session ${runId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function bootDiff(runA: string, runB: string): Promise<void> {
  const app = document.getElementById("app") as HTMLElement;
  app.innerHTML = "";

  const header = el("header", "diff-page-head");
  const graphSection = el("section", "diff-page-graph");
  const timelineSection = el("section", "diff-page-timeline");
  const bottom = el("div", "diff-page-bottom");
  const streamHost = el("div", "diff-page-stream");
  const inspectorHost = el("aside", "diff-page-inspector");
  bottom.appendChild(streamHost);
  bottom.appendChild(inspectorHost);
  app.appendChild(header);
  app.appendChild(graphSection);
  app.appendChild(timelineSection);
  app.appendChild(bottom);

  const store = new DiffStore(runA, runB);
  const headerView = new DiffHeaderView(header, store);
  const graphView = new DiffGraphView(graphSection, store);
  const timelineView = new DiffTimelineView(timelineSection, store);
  const streamView = new DiffStreamView(streamHost, store);
  const inspectorView = new DiffInspectorView(inspectorHost, store);
  void inspectorView;

  headerView.render();
  graphView.render();
  timelineView.render();
  streamView.render();

  try {
    const [diff, tlA, tlB] = await Promise.all([
      getDiff(runA, runB),
      getTimeline(runA),
      getTimeline(runB),
    ]);
    store.setDiff(diff);
    store.setTimelines(tlA, tlB);
    headerView.render();
    graphView.render();
    timelineView.render();
    streamView.render();
    inspectorView.render();
  } catch (err) {
    fail(`Could not load diff ${runA} / ${runB}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const diffMatch = window.location.pathname.match(/^\/diff\/([^/]+)\/([^/]+)$/);
const match = window.location.pathname.match(/^\/runs\/([^/]+)$/);
const liveMatch = window.location.pathname.match(/^\/live\/([^/]+)$/);
// Static exports boot directly from the embedded route shim instead of the
// URL path (history manipulation is unreliable on file:// URLs).
const staticRoute = (
  window as unknown as {
    __GG_STATIC_ROUTE__?: { kind: string; runId?: string; runA?: string; runB?: string };
  }
).__GG_STATIC_ROUTE__;
if (staticRoute?.kind === "diff" && staticRoute.runA && staticRoute.runB) {
  void bootDiff(staticRoute.runA, staticRoute.runB);
} else if (staticRoute?.kind === "run" && staticRoute.runId) {
  void bootRun(staticRoute.runId);
} else if (diffMatch?.[1] && diffMatch?.[2]) {
  void bootDiff(decodeURIComponent(diffMatch[1]), decodeURIComponent(diffMatch[2]));
} else if (liveMatch?.[1]) {
  void bootLive(decodeURIComponent(liveMatch[1]));
} else if (match?.[1]) {
  void bootRun(decodeURIComponent(match[1]));
} else {
  void bootPicker();
}
