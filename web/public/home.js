// Home page: "Shuffle" swaps the explore grid for a fresh random set.
(function () {
  var btn = document.querySelector("[data-reshuffle]");
  var grid = document.getElementById("featured-grid");
  if (!btn || !grid) return;

  var LANG = document.documentElement.lang || "en";
  var LP = ["fr", "es", "pt", "de"].indexOf(LANG) >= 0 ? "/" + LANG : "";

  function esc(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  btn.addEventListener("click", function () {
    btn.disabled = true;
    fetch("/api/random?n=12&lang=" + encodeURIComponent(LANG))
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        grid.innerHTML = (data.items || [])
          .map(function (k) {
            return (
              '<li><a href="' + LP + '/kanji/' +
              encodeURIComponent(k.literal) +
              '"><span class="glyph">' +
              esc(k.literal) +
              '</span><span class="gloss">' +
              esc(k.meaning) +
              "</span></a></li>"
            );
          })
          .join("");
        grid.classList.remove("just-shuffled");
        void grid.offsetWidth;
        grid.classList.add("just-shuffled");
      })
      .catch(function () {})
      .finally(function () {
        btn.disabled = false;
      });
  });
})();
