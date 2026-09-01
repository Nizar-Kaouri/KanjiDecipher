// Dynamic suggestions under a search bar. Debounced fetch to /api/suggest,
// keyboard-navigable, click/tap or Enter opens a kanji page. Plain Enter with no
// selection just submits the form (full results page).
// Attaches to every form.search on the page (header + hero).
(function () {
  var forms = document.querySelectorAll("form.search");
  if (!forms.length) return;

  var LANG = document.documentElement.lang || "en";

  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function attach(form, idx) {
    var input = form.querySelector('input[name="q"]');
    if (!input) return;

    var box = document.createElement("div");
    box.className = "suggest";
    box.id = "suggest-list-" + idx;
    box.setAttribute("role", "listbox");
    box.hidden = true;
    form.appendChild(box);

    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-controls", box.id);
    input.setAttribute("aria-expanded", "false");

    var items = [];
    var active = -1;
    var timer = null;
    var ctrl = null;

    function close() {
      box.hidden = true;
      active = -1;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
    }

    // Rebuild the list. Only called when the set of items changes — NOT for
    // highlight changes, so a tapped <a> is never destroyed before its click
    // lands (a mobile tap fires a synthetic mousemove first).
    function render() {
      if (!items.length) {
        close();
        return;
      }
      box.innerHTML = items
        .map(function (it, i) {
          return (
            '<a class="suggest-item" role="option" id="' +
            box.id +
            "-" +
            i +
            '" href="' +
            esc(it.href || "/kanji/" + encodeURIComponent(it.literal)) +
            '">' +
            '<span class="s-glyph">' +
            esc(it.literal) +
            "</span>" +
            '<span class="s-gloss">' +
            esc(it.meaning) +
            "</span>" +
            '<span class="s-reason">' +
            esc(it.reason) +
            "</span>" +
            "</a>"
          );
        })
        .join("");
      box.hidden = false;
      input.setAttribute("aria-expanded", "true");
      setActive(active);
    }

    // Highlight only — toggles a class on the existing nodes, no DOM rebuild.
    function setActive(i) {
      active = i;
      var nodes = box.children;
      for (var n = 0; n < nodes.length; n++) {
        nodes[n].classList.toggle("active", n === active);
      }
      if (active >= 0 && nodes[active]) {
        input.setAttribute("aria-activedescendant", box.id + "-" + active);
      } else {
        input.removeAttribute("aria-activedescendant");
      }
    }

    function load(q) {
      if (ctrl) ctrl.abort();
      ctrl = new AbortController();
      fetch("/api/suggest?lang=" + encodeURIComponent(LANG) + "&q=" + encodeURIComponent(q), { signal: ctrl.signal })
        .then(function (r) {
          return r.json();
        })
        .then(function (data) {
          if ((data.q || "") !== input.value.trim()) return; // stale response
          items = data.items || [];
          active = -1;
          render();
        })
        .catch(function () {
          /* aborted or network error — ignore */
        });
    }

    input.addEventListener("input", function () {
      var q = input.value.trim();
      if (timer) clearTimeout(timer);
      if (!q) {
        items = [];
        close();
        return;
      }
      timer = setTimeout(function () {
        load(q);
      }, 110);
    });

    input.addEventListener("keydown", function (e) {
      if (box.hidden || !items.length) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive(active + 1 >= items.length ? 0 : active + 1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive(active - 1 < 0 ? items.length - 1 : active - 1);
      } else if (e.key === "Enter") {
        if (active >= 0 && items[active]) {
          e.preventDefault();
          window.location.href =
            items[active].href || "/kanji/" + encodeURIComponent(items[active].literal);
        }
      } else if (e.key === "Escape") {
        close();
      }
    });

    // Mouse hover highlight (pointer only — a touch tap should just navigate).
    box.addEventListener("pointermove", function (e) {
      if (e.pointerType && e.pointerType !== "mouse") return;
      var el = e.target.closest(".suggest-item");
      if (!el) return;
      var i = Number(el.id.slice(el.id.lastIndexOf("-") + 1));
      if (i !== active) setActive(i);
    });

    // Clicking empty padding inside the box shouldn't blur the input; a click on
    // an actual suggestion link must navigate normally, so never touch those.
    box.addEventListener("mousedown", function (e) {
      if (!e.target.closest("a")) e.preventDefault();
    });

    document.addEventListener("click", function (e) {
      if (!form.contains(e.target)) close();
    });
    input.addEventListener("blur", function () {
      setTimeout(close, 150);
    });
  }

  forms.forEach(attach);
})();
