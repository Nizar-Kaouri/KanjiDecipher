// Colour-theme toggle: cycles system -> light -> dark -> system.
// The saved choice is applied pre-paint by an inline script in <head>;
// this only wires the button and keeps localStorage in sync.
(function () {
  var root = document.documentElement;
  var btn = document.querySelector(".theme-toggle");
  if (!btn) return;

  var ORDER = ["system", "light", "dark"];

  function current() {
    return root.getAttribute("data-theme") || "system";
  }

  function describe(mode) {
    var next = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length];
    return "Theme: " + mode + " — switch to " + next;
  }

  function apply(mode) {
    if (mode === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", mode);
    try {
      if (mode === "system") localStorage.removeItem("theme");
      else localStorage.setItem("theme", mode);
    } catch (e) {}
    var text = describe(mode);
    btn.setAttribute("aria-label", text);
    btn.setAttribute("title", text);
  }

  btn.addEventListener("click", function () {
    apply(ORDER[(ORDER.indexOf(current()) + 1) % ORDER.length]);
  });

  // Reflect the current state in the label on load.
  apply(current());

  // If the OS theme changes while in "system" mode, nothing to do — CSS handles
  // it — but refresh the label in case a screen reader re-reads it.
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
      if (current() === "system") apply("system");
    });
  }
})();
