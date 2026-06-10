/* FlowRail (left) + DetailDrawer (right): coverage status, cost & table
   summaries, ordered steps, and per-node detail. */

const {
  useRef: useRefP,
  useEffect: useEffectP,
  useMemo: useMemoP
} = React;
const NODE_BY_ID = Object.fromEntries(window.MAP.NODES.map(n => [n.id, n]));
function nTitle(id) {
  return (NODE_BY_ID[id] || {}).title || id;
}

/* aggregate a flow's external costs / table writes / reads */
function flowAgg(flow) {
  const cost = new Set(),
    writes = new Set(),
    reads = new Set();
  flow.steps.forEach(s => {
    (s.cost || []).forEach(c => cost.add(c));
    (s.writes || []).forEach(w => writes.add(w));
    (s.reads || []).forEach(r => reads.add(r));
  });
  return {
    cost: [...cost],
    writes: [...writes],
    reads: [...reads]
  };
}
/* which flows write / read a given table */
function tableUsage(table) {
  const writes = [],
    reads = [];
  window.MAP.FLOWS.forEach(f => {
    const w = f.steps.some(s => s.writes && s.writes.includes(table));
    const r = f.steps.some(s => s.reads && s.reads.includes(table));
    if (w) writes.push(f);
    if (r) reads.push(f);
  });
  return {
    writes,
    reads
  };
}
function flowsForNode(nodeId) {
  return window.MAP.FLOWS.filter(f => f.steps.some(s => s.from === nodeId || s.to === nodeId));
}
const COST_LABEL = {
  anthropic: "Anthropic $",
  openai: "OpenAI $",
  groq: "Groq $",
  resend: "Resend $"
};

/* ---------------------------------------------------------------- rail -- */
function FlowRail({
  activeFlow,
  onSelFlow,
  onClear,
  toggles,
  setToggles,
  onFit
}) {
  const {
    FLOWS,
    STATUS
  } = window.MAP;
  const groups = useMemoP(() => {
    const order = [],
      map = {};
    FLOWS.forEach(f => {
      if (!map[f.group]) {
        map[f.group] = [];
        order.push(f.group);
      }
      map[f.group].push(f);
    });
    return order.map(g => ({
      name: g,
      flows: map[g]
    }));
  }, [FLOWS]);
  const counts = useMemoP(() => {
    const c = {
      live: 0,
      partial: 0,
      planned: 0
    };
    FLOWS.forEach(f => {
      c[f.status]++;
    });
    return c;
  }, [FLOWS]);
  return /*#__PURE__*/React.createElement("aside", {
    className: "rail"
  }, /*#__PURE__*/React.createElement("div", {
    className: "rail-head"
  }, /*#__PURE__*/React.createElement("div", {
    className: "brand"
  }, "filter", /*#__PURE__*/React.createElement("span", {
    className: "brand-dot"
  }, "."), "fyi"), /*#__PURE__*/React.createElement("div", {
    className: "brand-sub"
  }, "system map \xB7 frontend \u2194 backend")), /*#__PURE__*/React.createElement("button", {
    className: "flowbtn topo" + (!activeFlow ? " is-active" : ""),
    onClick: onClear
  }, /*#__PURE__*/React.createElement("span", {
    className: "flowbtn-t"
  }, "\u21BA Full topology")), /*#__PURE__*/React.createElement("div", {
    className: "rail-scroll"
  }, groups.map(g => /*#__PURE__*/React.createElement("div", {
    className: "rail-group",
    key: g.name
  }, /*#__PURE__*/React.createElement("div", {
    className: "rail-group-h"
  }, g.name), g.flows.map(f => /*#__PURE__*/React.createElement("button", {
    key: f.id,
    className: "flowbtn" + (activeFlow && activeFlow.id === f.id ? " is-active" : ""),
    onClick: () => onSelFlow(f.id)
  }, /*#__PURE__*/React.createElement("span", {
    className: "dot",
    style: {
      background: STATUS[f.status].color
    }
  }), /*#__PURE__*/React.createElement("span", {
    className: "flowbtn-t"
  }, f.title), /*#__PURE__*/React.createElement("span", {
    className: "flowbtn-n"
  }, f.steps.length)))))), /*#__PURE__*/React.createElement("div", {
    className: "rail-foot"
  }, /*#__PURE__*/React.createElement("label", {
    className: "toggle"
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: toggles.cost,
    onChange: e => setToggles({
      ...toggles,
      cost: e.target.checked
    })
  }), /*#__PURE__*/React.createElement("span", null, "Highlight $ cost")), /*#__PURE__*/React.createElement("button", {
    className: "fitbtn",
    onClick: onFit
  }, "\u2922 Fit"), /*#__PURE__*/React.createElement("div", {
    className: "legend"
  }, /*#__PURE__*/React.createElement("div", {
    className: "legend-row"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lg"
  }, /*#__PURE__*/React.createElement("i", {
    className: "dot",
    style: {
      background: "var(--ok)"
    }
  }), "Live"), /*#__PURE__*/React.createElement("span", {
    className: "lg"
  }, /*#__PURE__*/React.createElement("i", {
    className: "dot",
    style: {
      background: "var(--warn)"
    }
  }), "Partial"), /*#__PURE__*/React.createElement("span", {
    className: "lg"
  }, /*#__PURE__*/React.createElement("i", {
    className: "dot",
    style: {
      background: "var(--dim)"
    }
  }), "Planned")), /*#__PURE__*/React.createElement("div", {
    className: "legend-row"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lg"
  }, /*#__PURE__*/React.createElement("i", {
    className: "sw sw-w"
  }), "writes"), /*#__PURE__*/React.createElement("span", {
    className: "lg"
  }, /*#__PURE__*/React.createElement("i", {
    className: "sw sw-r"
  }), "reads"), /*#__PURE__*/React.createElement("span", {
    className: "lg"
  }, /*#__PURE__*/React.createElement("i", {
    className: "sw sw-cost"
  }), "billed"))), /*#__PURE__*/React.createElement("div", {
    className: "coverage"
  }, counts.live, " live \xB7 ", counts.partial, " partial \xB7 ", counts.planned, " planned")));
}

/* ------------------------------------------------------------- drawer -- */
function DetailDrawer(props) {
  const {
    activeFlow,
    stepIndex,
    playing,
    selNode,
    ctl
  } = props;
  if (selNode) return /*#__PURE__*/React.createElement(NodeDetail, {
    node: NODE_BY_ID[selNode],
    onClose: ctl.clearNode,
    onSelFlow: ctl.selFlow
  });
  if (activeFlow) return /*#__PURE__*/React.createElement(FlowDetail, {
    flow: activeFlow,
    stepIndex: stepIndex,
    playing: playing,
    ctl: ctl
  });
  return /*#__PURE__*/React.createElement(Intro, {
    onSelFlow: ctl.selFlow
  });
}
function Pill({
  status
}) {
  const s = window.MAP.STATUS[status];
  return /*#__PURE__*/React.createElement("span", {
    className: "pill",
    style: {
      "--pc": s.color
    }
  }, s.label);
}
function FlowDetail({
  flow,
  stepIndex,
  playing,
  ctl
}) {
  const agg = useMemoP(() => flowAgg(flow), [flow]);
  const listRef = useRefP(null);
  useEffectP(() => {
    const el = listRef.current;
    if (!el) return;
    const row = el.querySelector(".step.is-cur");
    if (row) {
      const top = row.offsetTop - el.clientHeight / 2 + row.clientHeight / 2;
      el.scrollTo({
        top: Math.max(0, top),
        behavior: "smooth"
      });
    }
  }, [stepIndex, flow]);
  return /*#__PURE__*/React.createElement("div", {
    className: "drawer"
  }, /*#__PURE__*/React.createElement("div", {
    className: "drawer-head"
  }, /*#__PURE__*/React.createElement("button", {
    className: "x",
    onClick: ctl.clearFlow
  }, "\u2190 all flows"), /*#__PURE__*/React.createElement(Pill, {
    status: flow.status
  })), /*#__PURE__*/React.createElement("h2", {
    className: "drawer-title"
  }, flow.title), /*#__PURE__*/React.createElement("div", {
    className: "drawer-group"
  }, flow.group), /*#__PURE__*/React.createElement("p", {
    className: "blurb"
  }, flow.blurb), /*#__PURE__*/React.createElement("div", {
    className: "aggs"
  }, agg.cost.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "agg"
  }, /*#__PURE__*/React.createElement("div", {
    className: "agg-h agg-h--cost"
  }, "Calls out ($)"), /*#__PURE__*/React.createElement("div", {
    className: "chips"
  }, agg.cost.map(c => /*#__PURE__*/React.createElement("span", {
    key: c,
    className: "chip chip--cost"
  }, COST_LABEL[c] || c)))), agg.writes.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "agg"
  }, /*#__PURE__*/React.createElement("div", {
    className: "agg-h agg-h--w"
  }, "Writes"), /*#__PURE__*/React.createElement("div", {
    className: "chips"
  }, agg.writes.map(w => /*#__PURE__*/React.createElement("span", {
    key: w,
    className: "chip chip--w"
  }, w)))), agg.reads.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "agg"
  }, /*#__PURE__*/React.createElement("div", {
    className: "agg-h agg-h--r"
  }, "Reads"), /*#__PURE__*/React.createElement("div", {
    className: "chips"
  }, agg.reads.map(r => /*#__PURE__*/React.createElement("span", {
    key: r,
    className: "chip chip--r"
  }, r)))), agg.cost.length === 0 && /*#__PURE__*/React.createElement("div", {
    className: "agg"
  }, /*#__PURE__*/React.createElement("div", {
    className: "agg-h agg-h--free"
  }, "No paid calls"))), /*#__PURE__*/React.createElement("div", {
    className: "controls"
  }, /*#__PURE__*/React.createElement("button", {
    onClick: ctl.restart,
    title: "Restart"
  }, "\u27F2"), /*#__PURE__*/React.createElement("button", {
    onClick: () => ctl.step(-1),
    title: "Previous",
    disabled: stepIndex <= 0
  }, "\u25C0"), /*#__PURE__*/React.createElement("button", {
    className: "play",
    onClick: ctl.togglePlay
  }, playing ? "❚❚ pause" : "▶ play"), /*#__PURE__*/React.createElement("button", {
    onClick: () => ctl.step(1),
    title: "Next",
    disabled: stepIndex >= flow.steps.length - 1
  }, "\u25B6"), /*#__PURE__*/React.createElement("span", {
    className: "counter"
  }, stepIndex + 1, " / ", flow.steps.length)), /*#__PURE__*/React.createElement("div", {
    className: "steps",
    ref: listRef
  }, flow.steps.map((s, i) => {
    const cur = i === stepIndex,
      done = i < stepIndex;
    return /*#__PURE__*/React.createElement("button", {
      key: i,
      className: "step" + (cur ? " is-cur" : "") + (done ? " is-done" : ""),
      onClick: () => ctl.pick(i)
    }, /*#__PURE__*/React.createElement("span", {
      className: "step-n"
    }, i + 1), /*#__PURE__*/React.createElement("div", {
      className: "step-body"
    }, /*#__PURE__*/React.createElement("div", {
      className: "step-route"
    }, nTitle(s.from), " ", /*#__PURE__*/React.createElement("span", {
      className: "arr"
    }, "\u2192"), " ", nTitle(s.to)), /*#__PURE__*/React.createElement("div", {
      className: "step-label"
    }, s.label), s.note && /*#__PURE__*/React.createElement("div", {
      className: "step-note"
    }, s.note), /*#__PURE__*/React.createElement("div", {
      className: "step-badges"
    }, (s.cost || []).map(c => /*#__PURE__*/React.createElement("span", {
      key: c,
      className: "b b--cost"
    }, COST_LABEL[c] || c)), (s.writes || []).map(w => /*#__PURE__*/React.createElement("span", {
      key: "w" + w,
      className: "b b--w"
    }, "+", w)), (s.reads || []).map(r => /*#__PURE__*/React.createElement("span", {
      key: "r" + r,
      className: "b b--r"
    }, "\xB7", r)))));
  })));
}
function NodeDetail({
  node,
  onClose,
  onSelFlow
}) {
  if (!node) return null;
  const flows = useMemoP(() => flowsForNode(node.id), [node]);
  const kindLabel = {
    actor: "Actor",
    service: "Service",
    datastore: "Data store",
    external: "External",
    clock: "Scheduler"
  }[node.kind];
  return /*#__PURE__*/React.createElement("div", {
    className: "drawer"
  }, /*#__PURE__*/React.createElement("div", {
    className: "drawer-head"
  }, /*#__PURE__*/React.createElement("button", {
    className: "x",
    onClick: onClose
  }, "\u2190 close"), /*#__PURE__*/React.createElement("span", {
    className: "pill",
    style: {
      "--pc": "var(--ink)"
    }
  }, kindLabel, node.cost ? " · $" : "")), /*#__PURE__*/React.createElement("h2", {
    className: "drawer-title"
  }, node.title), /*#__PURE__*/React.createElement("div", {
    className: "drawer-group mono"
  }, node.tag), /*#__PURE__*/React.createElement("p", {
    className: "blurb"
  }, node.about), node.specs && /*#__PURE__*/React.createElement("ul", {
    className: "specs"
  }, node.specs.map((s, i) => /*#__PURE__*/React.createElement("li", {
    key: i
  }, s))), node.kind === "datastore" && node.tables && /*#__PURE__*/React.createElement("div", {
    className: "tables"
  }, /*#__PURE__*/React.createElement("div", {
    className: "tables-h"
  }, "Tables"), node.tables.map(tb => {
    const u = tableUsage(tb.name);
    return /*#__PURE__*/React.createElement("div", {
      key: tb.name,
      className: "trow" + (tb.dead ? " trow--dead" : "")
    }, /*#__PURE__*/React.createElement("div", {
      className: "trow-name"
    }, tb.name, tb.dead && /*#__PURE__*/React.createElement("span", {
      className: "dead-tag"
    }, "deprecated")), /*#__PURE__*/React.createElement("div", {
      className: "trow-note"
    }, tb.note), (u.writes.length > 0 || u.reads.length > 0) && /*#__PURE__*/React.createElement("div", {
      className: "trow-flows"
    }, u.writes.map(f => /*#__PURE__*/React.createElement("button", {
      key: "w" + f.id,
      className: "miniflow miniflow--w",
      onClick: () => onSelFlow(f.id)
    }, "+ ", f.title)), u.reads.map(f => /*#__PURE__*/React.createElement("button", {
      key: "r" + f.id,
      className: "miniflow miniflow--r",
      onClick: () => onSelFlow(f.id)
    }, "\xB7 ", f.title))));
  })), /*#__PURE__*/React.createElement("div", {
    className: "node-flows"
  }, /*#__PURE__*/React.createElement("div", {
    className: "tables-h"
  }, "Appears in"), /*#__PURE__*/React.createElement("div", {
    className: "chips"
  }, flows.map(f => /*#__PURE__*/React.createElement("button", {
    key: f.id,
    className: "chip chip--flow",
    onClick: () => onSelFlow(f.id)
  }, /*#__PURE__*/React.createElement("span", {
    className: "dot",
    style: {
      background: window.MAP.STATUS[f.status].color
    }
  }), f.title)))));
}
function Intro({
  onSelFlow
}) {
  const f = window.MAP.FLOWS;
  const M = window.MAP;
  const starters = (M.starters || ["anon-try", "telegram", "magic-link", "error-scan"]).filter(id => f.find(x => x.id === id));
  return /*#__PURE__*/React.createElement("div", {
    className: "drawer intro"
  }, /*#__PURE__*/React.createElement("h2", {
    className: "drawer-title"
  }, M.introTitle || "How it fits together"), /*#__PURE__*/React.createElement("p", {
    className: "blurb"
  }, M.introBlurb || "A live map of both repos as one system — the Cloudflare Worker at the edge, the FastAPI bot on Fly, and every third party they call."), /*#__PURE__*/React.createElement("ul", {
    className: "howto"
  }, /*#__PURE__*/React.createElement("li", null, /*#__PURE__*/React.createElement("b", null, "Pick a flow"), " on the left to light up its path and step through it."), /*#__PURE__*/React.createElement("li", null, /*#__PURE__*/React.createElement("b", null, "Click any box"), " for what it does and the data it touches."), /*#__PURE__*/React.createElement("li", null, /*#__PURE__*/React.createElement("b", null, "Toggle \u201C$ cost\u201D"), " to see where the system calls paid services."), /*#__PURE__*/React.createElement("li", null, "Datastore chips tint ", /*#__PURE__*/React.createElement("i", {
    className: "sw sw-w"
  }), "green on write, ", /*#__PURE__*/React.createElement("i", {
    className: "sw sw-r"
  }), "blue on read for the active flow.")), /*#__PURE__*/React.createElement("div", {
    className: "tables-h"
  }, "Start with"), /*#__PURE__*/React.createElement("div", {
    className: "chips"
  }, starters.map(id => {
    const fl = f.find(x => x.id === id);
    return /*#__PURE__*/React.createElement("button", {
      key: id,
      className: "chip chip--flow",
      onClick: () => onSelFlow(id)
    }, fl.title);
  })), /*#__PURE__*/React.createElement("div", {
    className: "intro-note"
  }, M.introNote || "Built from the actual source — routes, tables, models and prices are lifted from the code, not guessed."));
}
window.FlowRail = FlowRail;
window.DetailDrawer = DetailDrawer;