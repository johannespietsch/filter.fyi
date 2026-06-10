/* App — owns state, controls, auto-framing, keyboard. */
const {
  useState: uS,
  useEffect: uE,
  useRef: uR,
  useCallback: uC,
  useMemo: uM
} = React;
function App() {
  const {
    CANVAS,
    NODES,
    FLOWS
  } = window.MAP;
  const NB = uM(() => Object.fromEntries(NODES.map(n => [n.id, n])), [NODES]);
  const [activeId, setActiveId] = uS(null);
  const [stepIndex, setStepIndex] = uS(0);
  const [playing, setPlaying] = uS(false);
  const [hoverNode, setHoverNode] = uS(null);
  const [selNode, setSelNode] = uS(null);
  const [toggles, setToggles] = uS({
    cost: false
  });
  const [view, setView] = uS({
    scale: 0.62,
    tx: 30,
    ty: 24
  });
  const wrapRef = uR(null);
  const activeFlow = uM(() => FLOWS.find(f => f.id === activeId) || null, [activeId, FLOWS]);

  /* ---- framing ---- */
  const frameTo = uC((bbox, pad) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const r = wrap.getBoundingClientRect();
    const cw = r.width,
      ch = r.height;
    const p = pad == null ? 70 : pad;
    let scale = Math.min((cw - 2 * p) / bbox.w, (ch - 2 * p) / bbox.h);
    scale = Math.max(0.3, Math.min(1.7, scale));
    const tx = (cw - bbox.w * scale) / 2 - bbox.x * scale;
    const ty = (ch - bbox.h * scale) / 2 - bbox.y * scale;
    setView({
      scale,
      tx,
      ty
    });
  }, []);
  const frameAll = uC(() => frameTo({
    x: 0,
    y: 0,
    w: CANVAS.w,
    h: CANVAS.h
  }, 34), [frameTo]);
  const frameFlow = uC(flow => {
    let minX = 1e9,
      minY = 1e9,
      maxX = -1e9,
      maxY = -1e9;
    const ids = new Set();
    flow.steps.forEach(s => {
      ids.add(s.from);
      ids.add(s.to);
    });
    ids.forEach(id => {
      const n = NB[id];
      if (!n) return;
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.w);
      maxY = Math.max(maxY, n.y + n.h);
    });
    frameTo({
      x: minX,
      y: minY,
      w: maxX - minX,
      h: maxY - minY
    }, 90);
  }, [NB, frameTo]);
  uE(() => {
    const t = setTimeout(frameAll, 60);
    return () => clearTimeout(t);
  }, []);

  /* ---- controls ---- */
  const selFlow = uC(id => {
    const f = FLOWS.find(x => x.id === id);
    if (!f) return;
    setSelNode(null);
    setActiveId(id);
    setStepIndex(0);
    setPlaying(true);
    setTimeout(() => frameFlow(f), 0);
  }, [FLOWS, frameFlow]);
  const clearFlow = uC(() => {
    setActiveId(null);
    setPlaying(false);
    setStepIndex(0);
  }, []);
  const onStepEnd = uC(() => {
    setStepIndex(i => {
      if (!activeFlow) return i;
      if (i < activeFlow.steps.length - 1) return i + 1;
      setPlaying(false);
      return i;
    });
  }, [activeFlow]);
  const togglePlay = uC(() => {
    if (!activeFlow) return;
    setPlaying(p => {
      if (!p && stepIndex >= activeFlow.steps.length - 1) {
        setStepIndex(0);
        return true;
      }
      return !p;
    });
  }, [activeFlow, stepIndex]);
  const step = uC(d => {
    if (!activeFlow) return;
    setPlaying(false);
    setStepIndex(i => Math.max(0, Math.min(activeFlow.steps.length - 1, i + d)));
  }, [activeFlow]);
  const pick = uC(i => {
    setPlaying(false);
    setStepIndex(i);
  }, []);
  const restart = uC(() => {
    setStepIndex(0);
    setPlaying(true);
  }, []);
  const ctl = uM(() => ({
    selFlow,
    clearFlow,
    togglePlay,
    step,
    pick,
    restart,
    clearNode: () => setSelNode(null)
  }), [selFlow, clearFlow, togglePlay, step, pick, restart]);

  /* ---- keyboard ---- */
  uE(() => {
    const onKey = e => {
      if (e.key === "Escape") {
        setSelNode(null);
        clearFlow();
      }
      if (!activeFlow) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        step(1);
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        step(-1);
      }
      if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeFlow, step, togglePlay, clearFlow]);
  return /*#__PURE__*/React.createElement("div", {
    className: "app"
  }, /*#__PURE__*/React.createElement(FlowRail, {
    activeFlow: activeFlow,
    onSelFlow: selFlow,
    onClear: clearFlow,
    toggles: toggles,
    setToggles: setToggles,
    onFit: () => activeFlow ? frameFlow(activeFlow) : frameAll()
  }), /*#__PURE__*/React.createElement("main", {
    className: "stage-col"
  }, /*#__PURE__*/React.createElement(MapCanvas, {
    view: view,
    setView: setView,
    activeFlow: activeFlow,
    stepIndex: stepIndex,
    playing: playing,
    onStepEnd: onStepEnd,
    hoverNode: hoverNode,
    selNode: selNode,
    onHoverNode: setHoverNode,
    onSelNode: setSelNode,
    toggles: toggles,
    wrapRef: wrapRef,
    onFit: () => activeFlow ? frameFlow(activeFlow) : frameAll()
  }), /*#__PURE__*/React.createElement("div", {
    className: "hint"
  }, /*#__PURE__*/React.createElement("span", null, "scroll = zoom"), /*#__PURE__*/React.createElement("span", null, "drag = pan"), /*#__PURE__*/React.createElement("span", null, "\u2190 \u2192 step \xB7 space play \xB7 esc clear"))), /*#__PURE__*/React.createElement(DetailDrawer, {
    activeFlow: activeFlow,
    stepIndex: stepIndex,
    playing: playing,
    selNode: selNode,
    ctl: ctl
  }));
}
ReactDOM.createRoot(document.getElementById("root")).render(/*#__PURE__*/React.createElement(App, null));