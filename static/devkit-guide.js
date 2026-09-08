(() => {
  "use strict";
  const guide = document.querySelector("#modal-devkit-guide");
  if (!guide) return;
  const rows = [...guide.querySelectorAll("[data-led-row]")];
  const controls = [...guide.querySelectorAll("[data-led-target]")];
  let hovered = null;
  let focused = null;
  let selected = null;
  function paint() {
    const active = hovered || focused || selected;
    guide.querySelectorAll("[data-led-flare]").forEach(flare => {
      flare.classList.toggle("is-active", flare.dataset.ledFlare === active);
    });
    rows.forEach(row => row.classList.toggle("is-active", row.dataset.ledRow === active));
    controls.forEach(button => button.setAttribute("aria-pressed", String(button.dataset.ledTarget === selected)));
  }
  rows.forEach(row => {
    row.addEventListener("pointerenter", event => {
      if (event.pointerType === "touch") return;
      hovered = row.dataset.ledRow;
      paint();
    });
    row.addEventListener("pointerleave", () => { hovered = null; paint(); });
  });
  controls.forEach(button => {
    button.addEventListener("focus", () => { focused = button.dataset.ledTarget; paint(); });
    button.addEventListener("blur", () => { focused = null; paint(); });
    button.addEventListener("click", () => {
      const key = button.dataset.ledTarget;
      selected = selected === key ? null : key;
      focused = null;
      paint();
    });
  });
  guide.addEventListener("close", () => { hovered = focused = selected = null; paint(); });
  const header = guide.querySelector(".devkit-guide-head");
  new ResizeObserver(() => {
    guide.style.setProperty("--guide-header-height", `${header.offsetHeight}px`);
  }).observe(header);
})();
