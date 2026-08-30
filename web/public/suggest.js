// Dynamic suggestions under a search bar. Debounced fetch to /api/suggest,
// keyboard-navigable, click or Enter to open a kanji page. Plain Enter with no
// selection just submits the form (full results page).
// Attaches to every form.search on the page (header + hero).
(function () {
  var forms = document.querySelectorAll("form.search");
  if (!forms.length) return;

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

    function render() {
      if (!items.length) {
        close();
        return;
      }
      box.innerHTML = items
        .map(function (it, i) {
          return (
            '<a class="suggest-item' +
            (i === active ? " active" : "") +
            '" role="option" id="' +
            box.id +
            "-" +
            i +
            '" href="/kanji/' +
            encodeURIComponent(it.literal) +
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
      if (active >= 0) input.setAttribute("aria-activedescendant", box.id + "-" + active);
      else input.removeAttribute("aria-activedescendant");
    }

    function load(q) {
      if (ctrl) ctrl.abort();
      ctrl = new AbortController();
      fetch("/api/suggest?q=" + encodeURIComponent(q), { signal: ctrl.signal })
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
        active = active + 1 >= items.length ? 0 : active + 1;
        render();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        active = active - 1 < 0 ? items.length - 1 : active - 1;
        render();
      } else if (e.key === "Enter") {
        if (active >= 0 && items[active]) {
          e.preventDefault();
          window.location.href = "/kanji/" + encodeURIComponent(items[active].literal);
        }
      } else if (e.key === "Escape") {
        close();
      }
    });

    box.addEventListener("mousemove", function (e) {
      var el = e.target.closest(".suggest-item");
      if (!el) return;
      var i = Number(el.id.slice(el.id.lastIndexOf("-") + 1));
      if (i !== active) {
        active = i;
        render();
      }
    });

    // Keep focus on input so the form still submits on Enter if not navigating.
    box.addEventListener("mousedown", function (e) {
      e.preventDefault();
    });

    document.addEventListener("click", function (e) {
      if (!form.contains(e.target)) close();
    });
    input.addEventListener("blur", function () {
      setTimeout(close, 120);
    });
  }

  forms.forEach(attach);
})();
