// Radical picker: toggle components, fetch matching kanji, render results.
(function () {
  var grid = document.querySelector(".rad-grid");
  if (!grid) return;
  var buttons = Array.prototype.slice.call(grid.querySelectorAll(".rad-btn"));
  var results = document.getElementById("rad-results");
  var count = document.getElementById("rad-count");
  var selBar = document.getElementById("rad-selected");
  var selList = document.getElementById("rad-selected-list");
  var clearBtn = document.getElementById("rad-clear");

  var LANG = grid.dataset.lang || "en";
  var LP = grid.dataset.lp || "";
  var S = {
    begin: grid.dataset.sBegin || "",
    searching: grid.dataset.sSearching || "",
    matches: grid.dataset.sMatches || "{n} · {parts}",
    matchesCapped: grid.dataset.sMatchesCapped || "{n}+ · {parts}",
    none: grid.dataset.sNone || "",
  };
  function fill(tpl, n, parts) {
    return tpl.replace("{n}", n).replace("{parts}", parts);
  }

  var selected = []; // { part, display }
  var ctrl = null;

  function parts() { return selected.map(function (s) { return s.part; }); }
  function labels() { return selected.map(function (s) { return s.display; }); }

  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function renderSelected() {
    selBar.hidden = selected.length === 0;
    selList.textContent = labels().join(" ");
    var chosen = parts();
    buttons.forEach(function (b) {
      b.classList.toggle("selected", chosen.indexOf(b.dataset.part) !== -1);
    });
  }

  function update() {
    renderSelected();
    if (!selected.length) {
      results.innerHTML = "";
      count.textContent = S.begin;
      return;
    }
    if (ctrl) ctrl.abort();
    ctrl = new AbortController();
    count.textContent = S.searching;
    fetch(
      "/api/by-radicals?lang=" + encodeURIComponent(LANG) +
        "&parts=" + encodeURIComponent(parts().join(",")),
      { signal: ctrl.signal },
    )
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var items = data.items || [];
        results.innerHTML = items
          .map(function (k) {
            return (
              '<li><a href="' + LP + '/kanji/' + encodeURIComponent(k.literal) + '">' +
              '<span class="glyph">' + esc(k.literal) + "</span>" +
              '<span class="gloss">' + esc(k.meaning) + "</span></a></li>"
            );
          })
          .join("");
        var joined = labels().join(" + ");
        if (!items.length) count.textContent = fill(S.none, 0, joined);
        else if (items.length >= 400) count.textContent = fill(S.matchesCapped, items.length, joined);
        else count.textContent = fill(S.matches, items.length, joined);
      })
      .catch(function () {});
  }

  grid.addEventListener("click", function (e) {
    var btn = e.target.closest(".rad-btn");
    if (!btn) return;
    var part = btn.dataset.part;
    var i = parts().indexOf(part);
    if (i === -1) selected.push({ part: part, display: btn.textContent.trim() });
    else selected.splice(i, 1);
    update();
  });

  clearBtn.addEventListener("click", function () {
    selected = [];
    update();
  });
})();
