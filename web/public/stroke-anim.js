// Stroke-order animation + component highlighting for the kanji detail page.
(function () {
  var view = document.getElementById("stroke-view");
  if (!view) return;

  var animWrap = view.querySelector(".sv-anim");
  var staticWrap = view.querySelector(".sv-static");
  var svg = animWrap.querySelector("svg");
  var strokes = Array.prototype.slice.call(svg.querySelectorAll(".kvg-stroke"));
  var controls = document.querySelector(".stroke-controls");

  // Prepare each stroke as a hidden dashed line.
  var lengths = strokes.map(function (p) {
    var len = 0;
    try { len = p.getTotalLength(); } catch (e) { len = 100; }
    p.style.transition = "none";
    p.style.strokeDasharray = len + " " + len;
    p.style.strokeDashoffset = String(len);
    return len;
  });

  var shown = 0;
  var timer = null;

  function setShown(n, animate) {
    shown = Math.max(0, Math.min(strokes.length, n));
    strokes.forEach(function (p, i) {
      var len = lengths[i];
      if (i < shown) {
        p.style.transition = animate ? "stroke-dashoffset " + Math.max(180, len * 9) + "ms linear" : "none";
        p.style.strokeDashoffset = "0";
      } else {
        p.style.transition = "none";
        p.style.strokeDashoffset = String(len);
      }
    });
  }

  function stop() { if (timer) { clearTimeout(timer); timer = null; } }

  function play() {
    stop();
    setShown(0, false); // reset: hide every stroke
    // Flush the "all hidden" state so the browser records offset = length as the
    // transition's start value; without this, reset + first draw collapse into
    // one frame and stroke 1 (already visible) never animates on a replay.
    void svg.getBoundingClientRect();
    var i = 0;
    (function next() {
      if (i >= strokes.length) return;
      setShown(i + 1, true);
      var len = lengths[i];
      i++;
      timer = setTimeout(next, Math.max(240, len * 9) + 90);
    })();
  }

  controls.addEventListener("click", function (e) {
    var act = e.target.getAttribute("data-act");
    if (!act) return;
    if (act === "play") play();
    else if (act === "step") { stop(); setShown(shown >= strokes.length ? 0 : shown + 1, true); }
    else if (act === "reset") { stop(); setShown(0, false); }
    else if (act === "toggle") {
      var showStatic = staticWrap.hasAttribute("hidden");
      staticWrap.toggleAttribute("hidden", !showStatic);
      animWrap.toggleAttribute("hidden", showStatic);
      e.target.textContent = showStatic ? "Animated" : "Numbered";
    }
  });

  // Start with all strokes visible (acts as a static diagram until "Play").
  setShown(strokes.length, false);

  // Component hover -> highlight that component's strokes.
  var comps = document.querySelectorAll(".component[data-component]");
  comps.forEach(function (el) {
    var idx = el.getAttribute("data-component");
    function on() {
      view.classList.add("dim");
      el.classList.add("active");
      strokes.forEach(function (p) {
        p.classList.toggle("hl", p.getAttribute("data-component") === idx);
      });
    }
    function off() {
      view.classList.remove("dim");
      el.classList.remove("active");
      strokes.forEach(function (p) { p.classList.remove("hl"); });
    }
    el.addEventListener("mouseenter", on);
    el.addEventListener("mouseleave", off);
    el.addEventListener("focus", on);
    el.addEventListener("blur", off);
  });
})();
