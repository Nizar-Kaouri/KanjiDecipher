// Language dropdown in the header. Switching rewrites the current URL with the
// chosen "/xx" prefix (English = no prefix), remembers the choice in a cookie,
// and navigates. Keep the language list in sync with web/i18n.js.
(function () {
  var PREFIXED = ["fr", "es", "pt", "de"];
  var sel = document.querySelector("[data-lang-switch]");
  if (!sel) return;

  sel.addEventListener("change", function () {
    var lang = sel.value;
    try {
      document.cookie =
        "lang=" + encodeURIComponent(lang) + ";path=/;max-age=31536000;samesite=lax";
    } catch (e) {}

    var path = location.pathname.replace(
      new RegExp("^/(" + PREFIXED.join("|") + ")(?=/|$)"),
      "",
    );
    if (!path) path = "/";
    var prefix = lang === "en" ? "" : "/" + lang;
    location.assign(prefix + path + location.search + location.hash);
  });
})();
