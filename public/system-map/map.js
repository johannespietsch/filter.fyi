/* MapCanvas — zones, nodes, bezier edges, animated packet. Pure presentational;
   view (pan/zoom), active flow, and step index are owned by App. */

const {
  useRef,
  useState,
  useEffect,
  useMemo,
  useCallback
} = React;

/* ---- geometry ---------------------------------------------------------- */
function anchorPair(a, b, offset) {
  const acx = a.x + a.w / 2,
    acy = a.y + a.h / 2;
  const bcx = b.x + b.w / 2,
    bcy = b.y + b.h / 2;
  const dx = bcx - acx,
    dy = bcy - acy;
  let ax, ay, bx, by, c1, c2;
  if (Math.abs(dx) >= Math.abs(dy)) {
    // horizontal
    if (dx >= 0) {
      ax = a.x + a.w;
      bx = b.x;
    } else {
      ax = a.x;
      bx = b.x + b.w;
    }
    ay = acy + offset;
    by = bcy + offset;
    const mx = ax + (bx - ax) * 0.5;
    c1 = {
      x: mx,
      y: ay
    };
    c2 = {
      x: mx,
      y: by
    };
  } else {
    // vertical
    if (dy >= 0) {
      ay = a.y + a.h;
      by = b.y;
    } else {
      ay = a.y;
      by = b.y + b.h;
    }
    ax = acx + offset;
    bx = bcx + offset;
    const my = ay + (by - ay) * 0.5;
    c1 = {
      x: ax,
      y: my
    };
    c2 = {
      x: bx,
      y: my
    };
  }
  return {
    p0: {
      x: ax,
      y: ay
    },
    c1,
    c2,
    p3: {
      x: bx,
      y: by
    }
  };
}
function bez(p0, c1, c2, p3, t) {
  const u = 1 - t;
  const a = u * u * u,
    b = 3 * u * u * t,
    c = 3 * u * t * t,
    d = t * t * t;
  return {
    x: a * p0.x + b * c1.x + c * c2.x + d * p3.x,
    y: a * p0.y + b * c1.y + c * c2.y + d * p3.y
  };
}
function pathD(g) {
  return `M ${g.p0.x} ${g.p0.y} C ${g.c1.x} ${g.c1.y} ${g.c2.x} ${g.c2.y} ${g.p3.x} ${g.p3.y}`;
}

/* Stable fan offset for parallel edges between the same pair of nodes. */
function buildOffsets(pairs) {
  const groups = {};
  pairs.forEach(p => {
    const key = [p.from, p.to].sort().join("|");
    (groups[key] = groups[key] || []).push(p);
  });
  const off = {};
  Object.values(groups).forEach(list => {
    const n = list.length;
    list.forEach((p, i) => {
      off[p.uid] = (i - (n - 1) / 2) * 15;
    });
  });
  return off;
}

/* ---- component --------------------------------------------------------- */
function MapCanvas(props) {
  const {
    view,
    setView,
    activeFlow,
    stepIndex,
    playing,
    onStepEnd,
    hoverNode,
    selNode,
    onHoverNode,
    onSelNode,
    toggles,
    wrapRef,
    onFit
  } = props;
  const {
    CANVAS,
    ZONES,
    NODES,
    FLOWS
  } = window.MAP;
  const nodeById = useMemo(() => Object.fromEntries(NODES.map(n => [n.id, n])), [NODES]);

  /* base topology: unique directed pairs across all flows */
  const baseEdges = useMemo(() => {
    const seen = {};
    const out = [];
    FLOWS.forEach(f => f.steps.forEach(s => {
      const k = s.from + ">" + s.to;
      if (!seen[k]) {
        seen[k] = true;
        out.push({
          from: s.from,
          to: s.to,
          uid: k
        });
      }
    }));
    const off = buildOffsets(out);
    return out.map(e => ({
      ...e,
      off: off[e.uid] || 0
    }));
  }, [FLOWS]);
  const baseGeom = useMemo(() => baseEdges.map(e => {
    const a = nodeById[e.from],
      b = nodeById[e.to];
    if (!a || !b) return null;
    return {
      ...e,
      g: anchorPair(a, b, e.off)
    };
  }).filter(Boolean), [baseEdges, nodeById]);

  /* active flow edges (ordered, fanned per repeated pair) */
  const activeEdges = useMemo(() => {
    if (!activeFlow) return [];
    const pairs = activeFlow.steps.map((s, i) => ({
      from: s.from,
      to: s.to,
      uid: "a" + i,
      i
    }));
    const off = buildOffsets(pairs);
    return activeFlow.steps.map((s, i) => {
      const a = nodeById[s.from],
        b = nodeById[s.to];
      if (!a || !b) return null;
      return {
        step: s,
        i,
        g: anchorPair(a, b, off["a" + i] || 0)
      };
    }).filter(Boolean);
  }, [activeFlow, nodeById]);
  const involved = useMemo(() => {
    if (!activeFlow) return null;
    const s = new Set();
    activeFlow.steps.forEach(st => {
      s.add(st.from);
      s.add(st.to);
    });
    return s;
  }, [activeFlow]);

  /* packet animation along the current step */
  const [t, setT] = useState(0);
  const raf = useRef(0);
  const last = useRef(0);
  useEffect(() => {
    cancelAnimationFrame(raf.current);
    if (!activeFlow || !playing) {
      setT(1);
      return;
    }
    setT(0);
    last.current = 0;
    const dur = 900;
    const tick = now => {
      if (!last.current) last.current = now;
      const dt = now - last.current;
      last.current = now;
      setT(prev => {
        let nx = prev + dt / dur;
        if (nx >= 1) {
          nx = 1;
          cancelAnimationFrame(raf.current);
          requestAnimationFrame(() => onStepEnd && onStepEnd());
        }
        return nx;
      });
      if (last.current) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [activeFlow, stepIndex, playing]);
  const curEdge = activeEdges.find(e => e.i === stepIndex);
  const packet = curEdge ? bez(curEdge.g.p0, curEdge.g.c1, curEdge.g.c2, curEdge.g.p3, t) : null;
  const packetCost = curEdge && curEdge.step.cost && curEdge.step.cost.length;

  /* ---- pan / zoom ---- */
  const drag = useRef(null);
  /* button zoom: step toward the viewport centre, briefly animated */
  const [zoomAnim, setZoomAnim] = useState(false);
  const animTimer = useRef(0);
  const zoomByFactor = useCallback(factor => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const r = wrap.getBoundingClientRect();
    const cx = r.width / 2,
      cy = r.height / 2;
    setZoomAnim(true);
    clearTimeout(animTimer.current);
    animTimer.current = setTimeout(() => setZoomAnim(false), 220);
    setView(v => {
      const ns = Math.min(2.4, Math.max(0.28, v.scale * factor));
      const k = ns / v.scale;
      return {
        scale: ns,
        tx: cx - (cx - v.tx) * k,
        ty: cy - (cy - v.ty) * k
      };
    });
  }, [setView, wrapRef]);
  const onWheel = useCallback(e => {
    e.preventDefault();
    const wrap = wrapRef.current;
    if (!wrap) return;
    const r = wrap.getBoundingClientRect();
    const mx = e.clientX - r.left,
      my = e.clientY - r.top;
    // Scale the step by the actual scroll delta (not a fixed ±10%) so a trackpad's
    // many small events add up to one smooth gesture instead of lurching. Normalise
    // across deltaMode (px/line/page) and clamp spikes so a fast flick can't jump.
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;else if (e.deltaMode === 2) dy *= r.height;
    dy = Math.max(-60, Math.min(60, dy));
    const factor = Math.exp(-dy * 0.0022);
    setView(v => {
      const ns = Math.min(2.4, Math.max(0.28, v.scale * factor));
      const k = ns / v.scale;
      return {
        scale: ns,
        tx: mx - (mx - v.tx) * k,
        ty: my - (my - v.ty) * k
      };
    });
  }, [setView, wrapRef]);
  const onDown = useCallback(e => {
    if (e.button !== 0) return;
    drag.current = {
      x: e.clientX,
      y: e.clientY,
      tx: view.tx,
      ty: view.ty
    };
  }, [view]);
  const onMove = useCallback(e => {
    if (!drag.current) return;
    setView(v => ({
      ...v,
      tx: drag.current.tx + (e.clientX - drag.current.x),
      ty: drag.current.ty + (e.clientY - drag.current.y)
    }));
  }, [setView]);
  const onUp = useCallback(() => {
    drag.current = null;
  }, []);
  useEffect(() => {
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [onMove, onUp]);
  const stage = {
    width: CANVAS.w,
    height: CANVAS.h,
    transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`
  };
  function nodeClass(n) {
    let c = "node node--" + n.kind;
    if (involved) c += involved.has(n.id) ? " is-on" : " is-off";
    if (toggles.cost && n.cost) c += " is-cost";
    if (selNode === n.id) c += " is-sel";
    if (hoverNode === n.id) c += " is-hover";
    return c;
  }
  return /*#__PURE__*/React.createElement("div", {
    className: "map-wrap",
    ref: wrapRef,
    onWheel: onWheel,
    onMouseDown: onDown
  }, /*#__PURE__*/React.createElement("div", {
    className: "map-zoom"
  }, /*#__PURE__*/React.createElement("button", {
    title: "Zoom in",
    onMouseDown: e => e.stopPropagation(),
    onClick: () => zoomByFactor(1.25)
  }, "+"), /*#__PURE__*/React.createElement("button", {
    title: "Zoom out",
    onMouseDown: e => e.stopPropagation(),
    onClick: () => zoomByFactor(0.8)
  }, "−"), /*#__PURE__*/React.createElement("button", {
    className: "zfit",
    title: "Fit to view",
    onMouseDown: e => e.stopPropagation(),
    onClick: () => onFit && onFit()
  }, "⤢")), /*#__PURE__*/React.createElement("div", {
    className: "map-stage" + (zoomAnim ? " is-anim" : ""),
    style: stage
  }, /*#__PURE__*/React.createElement("svg", {
    className: "edge-svg",
    width: CANVAS.w,
    height: CANVAS.h,
    viewBox: `0 0 ${CANVAS.w} ${CANVAS.h}`
  }, ZONES.map(z => /*#__PURE__*/React.createElement("g", {
    key: z.id
  }, /*#__PURE__*/React.createElement("rect", {
    x: z.x,
    y: z.y,
    width: z.w,
    height: z.h,
    rx: "10",
    fill: z.hue == null ? "rgba(40,38,33,0.025)" : `oklch(0.62 0.09 ${z.hue} / 0.05)`,
    stroke: z.hue == null ? "rgba(40,38,33,0.18)" : `oklch(0.55 0.10 ${z.hue} / 0.30)`,
    strokeWidth: "1",
    strokeDasharray: "2 4"
  }), /*#__PURE__*/React.createElement("text", {
    x: z.x + 14,
    y: z.y - 10,
    className: "zone-label",
    fill: z.hue == null ? "var(--dim)" : `oklch(0.48 0.10 ${z.hue})`
  }, z.label))), baseGeom.map(e => /*#__PURE__*/React.createElement("path", {
    key: e.uid,
    d: pathD(e.g),
    fill: "none",
    stroke: "var(--ink)",
    strokeWidth: "1",
    style: {
      opacity: activeFlow ? 0.05 : 0.13
    }
  })), activeEdges.map(e => {
    const done = e.i < stepIndex,
      cur = e.i === stepIndex;
    const cost = e.step.cost && e.step.cost.length;
    const col = cost && toggles.cost ? "var(--cost)" : "var(--flow)";
    const op = cur ? 1 : done ? 0.5 : 0.16;
    const ad = bez(e.g.p0, e.g.c1, e.g.c2, e.g.p3, 0.985);
    const ang = Math.atan2(e.g.p3.y - ad.y, e.g.p3.x - ad.x) * 180 / Math.PI;
    return /*#__PURE__*/React.createElement("g", {
      key: e.i,
      style: {
        opacity: op
      }
    }, /*#__PURE__*/React.createElement("path", {
      d: pathD(e.g),
      fill: "none",
      stroke: col,
      strokeWidth: cur ? 2.4 : 1.6,
      strokeLinecap: "round",
      strokeDasharray: !done && !cur ? "3 5" : "none"
    }), /*#__PURE__*/React.createElement("g", {
      transform: `translate(${e.g.p3.x} ${e.g.p3.y}) rotate(${ang})`
    }, /*#__PURE__*/React.createElement("path", {
      d: "M 0 0 L -8 -4 L -8 4 Z",
      fill: col
    })));
  }), packet && playing && /*#__PURE__*/React.createElement("g", null, /*#__PURE__*/React.createElement("circle", {
    cx: packet.x,
    cy: packet.y,
    r: "9",
    fill: packetCost ? "var(--cost)" : "var(--flow)",
    opacity: "0.18"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: packet.x,
    cy: packet.y,
    r: "4.5",
    fill: packetCost ? "var(--cost)" : "var(--flow)"
  }))), /*#__PURE__*/React.createElement("div", {
    className: "node-layer"
  }, NODES.map(n => /*#__PURE__*/React.createElement("div", {
    key: n.id,
    className: nodeClass(n),
    style: {
      left: n.x,
      top: n.y,
      width: n.w,
      height: n.h,
      "--zh": n.zone === "edge" ? 248 : n.zone === "fly" ? 152 : n.zone === "ext" ? 28 : 40
    },
    onMouseEnter: () => onHoverNode(n.id),
    onMouseLeave: () => onHoverNode(null),
    onClick: e => {
      e.stopPropagation();
      onSelNode(n.id);
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "node-bar"
  }), /*#__PURE__*/React.createElement("div", {
    className: "node-body"
  }, /*#__PURE__*/React.createElement("div", {
    className: "node-title"
  }, n.title, n.cost && /*#__PURE__*/React.createElement("span", {
    className: "node-dollar"
  }, "$")), /*#__PURE__*/React.createElement("div", {
    className: "node-tag"
  }, n.tag)), n.kind === "datastore" && n.tables && /*#__PURE__*/React.createElement("div", {
    className: "node-tables"
  }, n.tables.map(tb => {
    const w = involved && activeFlow && stepWritesTable(activeFlow, n.id, tb.name);
    const r = involved && activeFlow && stepReadsTable(activeFlow, n.id, tb.name);
    let cls = "tchip";
    if (tb.dead) cls += " tchip--dead";
    if (w) cls += " tchip--w";else if (r) cls += " tchip--r";
    return /*#__PURE__*/React.createElement("span", {
      key: tb.name,
      className: cls
    }, tb.name);
  })))), curEdge && (() => {
    const mid = bez(curEdge.g.p0, curEdge.g.c1, curEdge.g.c2, curEdge.g.p3, 0.5);
    return /*#__PURE__*/React.createElement("div", {
      className: "edge-label",
      style: {
        left: mid.x,
        top: mid.y
      }
    }, /*#__PURE__*/React.createElement("span", {
      className: "edge-num"
    }, stepIndex + 1), /*#__PURE__*/React.createElement("span", null, curEdge.step.label));
  })())));
}

/* which datastore tables a flow writes/reads (for chip tinting) */
function stepWritesTable(flow, nodeId, table) {
  return flow.steps.some(s => (s.to === nodeId || s.from === nodeId) && s.writes && s.writes.includes(table));
}
function stepReadsTable(flow, nodeId, table) {
  return flow.steps.some(s => (s.to === nodeId || s.from === nodeId) && s.reads && s.reads.includes(table));
}
window.MapCanvas = MapCanvas;
window.mapHelpers = {
  stepWritesTable,
  stepReadsTable
};