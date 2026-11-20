(() => {
  const NS = "http://www.w3.org/2000/svg";
  const W = 240;
  const MID = 16;
  const PLAY = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 1 L11 6 L2 11 Z"/></svg>';
  const PAUSE = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 1 H5 V11 H2 Z M7 1 H10 V11 H7 Z"/></svg>';
  const STEP = 2;
  const PAGE = 10;

  const clock = (s) => {
    const t = Number.isFinite(s) ? Math.max(0, Math.floor(s)) : 0;
    return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0");
  };

  const linesPath = (peaks, upTo) => {
    if (!peaks) return "M0 " + MID + "H" + (upTo * W).toFixed(1);
    const n = peaks.length;
    let d = "";
    for (let i = 0; i < n; i++) {
      const x = ((i + 0.5) * W) / n;
      if (x > upTo * W) break;
      const h = Math.max(0.75, peaks[i] * (MID - 1));
      d += "M" + x.toFixed(1) + " " + (MID - h).toFixed(1) + "V" + (MID + h).toFixed(1);
    }
    return d;
  };

  const upgrade = (clip) => {
    if (clip.dataset.ready) return;
    clip.dataset.ready = "1";
    const audio = clip.querySelector("audio");
    const button = clip.querySelector(".play");
    const wave = clip.querySelector(".wave");
    const time = clip.querySelector(".time");
    if (!audio || !button || !wave || !time) return;
    const details = clip.closest("details");
    let peaks = null;
    let asked = false;
    let broken = false;

    const markBroken = () => {
      broken = true;
      button.disabled = true;
      wave.setAttribute("aria-disabled", "true");
      time.textContent = "Recording gone";
    };

    const base = document.createElementNS(NS, "path");
    base.setAttribute("class", "base");
    const done = document.createElementNS(NS, "path");
    done.setAttribute("class", "done");
    wave.append(base, done);

    const draw = () => {
      if (broken) return;
      const total = audio.duration;
      const frac = Number.isFinite(total) && total > 0 ? Math.min(1, audio.currentTime / total) : 0;
      base.setAttribute("d", linesPath(peaks, 1));
      done.setAttribute("d", frac > 0 ? linesPath(peaks, frac) : "");
      time.textContent = clock(audio.currentTime) + " / " + clock(total);
      wave.setAttribute("aria-valuemax", String(Math.floor(Number.isFinite(total) ? total : 0)));
      wave.setAttribute("aria-valuenow", String(Math.floor(audio.currentTime)));
      wave.setAttribute("aria-valuetext", time.textContent);
    };

    const seekTo = (s) => {
      if (broken) return;
      if (!Number.isFinite(audio.duration)) return;
      audio.currentTime = Math.min(Math.max(0, s), audio.duration);
      draw();
    };

    const loadPeaks = () => {
      if (asked) return;
      asked = true;
      audio.preload = "metadata";
      fetch(clip.dataset.peaks)
        .then((r) => {
          if (r.status === 404) markBroken();
          return r.ok ? r.json() : Promise.reject(new Error("peaks " + r.status));
        })
        .then((j) => {
          peaks = Array.isArray(j.peaks) && j.peaks.length > 0 ? j.peaks : null;
        })
        .catch(() => {
          peaks = null;
        })
        .finally(draw);
    };

    audio.removeAttribute("controls");
    button.hidden = false;
    wave.removeAttribute("hidden");
    time.hidden = false;
    draw();

    button.addEventListener("click", () => {
      if (audio.paused) {
        audio.play().catch((e) => {
          if (!e || e.name !== "NotAllowedError") markBroken();
        });
      } else {
        audio.pause();
      }
    });
    wave.addEventListener("click", (e) => {
      const box = wave.getBoundingClientRect();
      if (box.width > 0) seekTo(((e.clientX - box.left) / box.width) * audio.duration);
    });
    wave.addEventListener("keydown", (e) => {
      const k = e.key;
      if (k === "ArrowLeft" || k === "ArrowDown") seekTo(audio.currentTime - STEP);
      else if (k === "ArrowRight" || k === "ArrowUp") seekTo(audio.currentTime + STEP);
      else if (k === "PageDown") seekTo(audio.currentTime - PAGE);
      else if (k === "PageUp") seekTo(audio.currentTime + PAGE);
      else if (k === "Home") seekTo(0);
      else if (k === "End") seekTo(audio.duration);
      else return;
      e.preventDefault();
    });
    audio.addEventListener("play", () => {
      button.innerHTML = PAUSE;
      button.setAttribute("aria-label", "Pause recording");
      document.querySelectorAll(".clip audio").forEach((other) => {
        if (other !== audio) other.pause();
      });
    });
    const paused = () => {
      button.innerHTML = PLAY;
      button.setAttribute("aria-label", "Play recording");
    };
    audio.addEventListener("pause", paused);
    audio.addEventListener("ended", paused);
    ["timeupdate", "loadedmetadata", "durationchange", "seeked"].forEach((n) => audio.addEventListener(n, draw));
    audio.addEventListener("error", markBroken);
    if (details) {
      details.addEventListener("toggle", () => {
        if (details.open) loadPeaks();
        else audio.pause();
      });
      if (details.open) loadPeaks();
    } else {
      loadPeaks();
    }
  };

  document.querySelectorAll(".clip").forEach(upgrade);
})();
