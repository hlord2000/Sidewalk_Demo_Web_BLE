/* ==========================================================================
   ui.js — generic, dependency-free tab controller shared by the dashboard and
   admin pages. Switching tabs is client-side so live connections (SSE, BLE)
   survive. Active tab is deep-linkable via the URL hash and remembered in
   localStorage. Emits a `tab:activated` event other scripts can listen for.
   ========================================================================== */
(function () {
  "use strict";

  function initTabset(nav) {
    const name = nav.dataset.tabset || "tabs";
    const buttons = Array.from(nav.querySelectorAll("[data-tab-target]"));
    const targets = new Set(buttons.map((b) => b.dataset.tabTarget));

    const panelFor = (target) =>
      document.querySelector(`[data-tab-panel="${target}"]`);

    function activate(target, options) {
      const push = !options || options.push !== false;
      if (!targets.has(target)) {
        return false;
      }
      for (const btn of buttons) {
        const isActive = btn.dataset.tabTarget === target;
        btn.setAttribute("aria-selected", isActive ? "true" : "false");
        btn.classList.toggle("tab--active", isActive);
        const panel = panelFor(btn.dataset.tabTarget);
        if (panel) {
          panel.hidden = !isActive;
        }
      }
      try {
        history.replaceState(null, "", push ? `#${target}` : window.location.pathname + window.location.search);
      } catch (err) {
        /* ignore (e.g. sandboxed history) */
      }
      try {
        window.localStorage.setItem(`tab:${name}`, target);
      } catch (err) {
        /* storage may be unavailable */
      }
      document.dispatchEvent(
        new CustomEvent("tab:activated", { detail: { tabset: name, target } })
      );
      return true;
    }

    for (const btn of buttons) {
      btn.addEventListener("click", () => activate(btn.dataset.tabTarget));
    }

    let initial = null;
    const hash = (window.location.hash || "").replace(/^#/, "");
    if (hash && targets.has(hash)) {
      initial = hash;
    }
    if (!initial) {
      try {
        const stored = window.localStorage.getItem(`tab:${name}`);
        if (stored && targets.has(stored)) {
          initial = stored;
        }
      } catch (err) {
        /* ignore */
      }
    }
    if (!initial && buttons.length) {
      initial = buttons[0].dataset.tabTarget;
    }
    if (initial) {
      activate(initial, { push: false });
    }

    return { name, activate };
  }

  function init() {
    // Capture the launch hash before the tab controller rewrites it.
    const launchHash = (window.location.hash || "").slice(1);

    const controllers = Array.from(document.querySelectorAll("[data-tabset]")).map(
      initTabset
    );

    for (const trigger of document.querySelectorAll(".js-go-tab")) {
      trigger.addEventListener("click", () => {
        const target = trigger.dataset.goTab;
        for (const controller of controllers) {
          controller.activate(target);
        }
      });
    }

    initModals(launchHash);
    initAutoSubmit();

    window.SidewalkUI = {
      activate(target) {
        for (const controller of controllers) {
          if (controller.activate(target)) {
            return true;
          }
        }
        return false;
      },
    };
  }

  // <dialog>-based modals: open via [data-open-modal="id"], close via
  // [data-close-modal] or backdrop click, and deep-link via #modal-...
  function initModals(launchHash) {
    for (const opener of document.querySelectorAll("[data-open-modal]")) {
      opener.addEventListener("click", () => {
        const dialog = document.getElementById(opener.dataset.openModal);
        if (dialog && typeof dialog.showModal === "function") {
          dialog.showModal();
        }
      });
    }

    for (const closer of document.querySelectorAll("[data-close-modal]")) {
      closer.addEventListener("click", () => {
        const dialog = closer.closest("dialog");
        if (dialog) {
          dialog.close();
        }
      });
    }

    for (const dialog of document.querySelectorAll("dialog")) {
      // Click on the backdrop (outside the card) closes the dialog.
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog) {
          dialog.close();
        }
      });
    }

    if (launchHash && launchHash.startsWith("modal-")) {
      const dialog = document.getElementById(launchHash);
      if (dialog && typeof dialog.showModal === "function") {
        dialog.showModal();
      }
    }
  }

  // Forms tagged .js-autosubmit save on change; hide their explicit submit.
  function initAutoSubmit() {
    for (const form of document.querySelectorAll("form.js-autosubmit")) {
      for (const submit of form.querySelectorAll('[type="submit"]')) {
        submit.hidden = true;
      }
      for (const input of form.querySelectorAll("input, select")) {
        input.addEventListener("change", () => form.submit());
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
