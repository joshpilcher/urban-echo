/* Accessible playback controls. Wave heights come from decoded audio samples. */
(() => {
  "use strict";
  const time = (value) => {
    const seconds = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
    return (
      Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0")
    );
  };
  window.EchoAudio = {
    create(player, label, feedback) {
      const root = document.createElement("div");
      root.className = "echo-audio";
      const play = document.createElement("button");
      play.type = "button";
      play.className = "audio-toggle";
      play.setAttribute("aria-label", "Play " + label);
      play.setAttribute("aria-pressed", "false");
      const glyph = document.createElement("span");
      glyph.className = "audio-play-glyph";
      glyph.setAttribute("aria-hidden", "true");
      play.append(glyph);
      const seekArea = document.createElement("div");
      seekArea.className = "wave-seek";
      const wave = document.createElement("div");
      wave.className = "wave-bars";
      wave.setAttribute("aria-hidden", "true");
      const bars = Array.from({ length: 48 }, () => {
        const bar = document.createElement("span");
        bar.style.height = "3px";
        wave.append(bar);
        return bar;
      });
      const seek = document.createElement("input");
      seek.type = "range";
      seek.min = "0";
      seek.max = "1";
      seek.step = "0.05";
      seek.value = "0";
      seek.disabled = true;
      seek.className = "wave-range";
      seek.setAttribute("aria-label", "Seek " + label);
      seekArea.append(wave, seek);
      const counter = document.createElement("span");
      counter.className = "audio-time";
      player.controls = false;
      player.hidden = true;
      root.append(player, play, seekArea, counter);
      let decodedDuration = 0,
        disposed = false;
      const controller = new AbortController();
      const duration = () =>
        Number.isFinite(player.duration) && player.duration > 0
          ? player.duration
          : decodedDuration;
      function update() {
        const length = duration(),
          current = Number.isFinite(player.currentTime)
            ? player.currentTime
            : 0;
        const playing = !player.paused && !player.ended;
        play.classList.toggle("is-playing", playing);
        play.setAttribute("aria-pressed", String(playing));
        play.setAttribute("aria-label", (playing ? "Pause " : "Play ") + label);
        seek.disabled = !length;
        seek.max = String(length || 1);
        seek.value = String(Math.min(current, length || 0));
        seek.setAttribute(
          "aria-valuetext",
          time(current) + " of " + time(length),
        );
        counter.textContent =
          time(current) + " / " + (length ? time(length) : "--:--");
        bars.forEach((bar, i) =>
          bar.classList.toggle(
            "is-played",
            length > 0 && i / 48 < current / length,
          ),
        );
      }
      play.addEventListener("click", async () => {
        if (!player.paused) {
          player.pause();
          return;
        }
        feedback.textContent = "";
        try {
          if (player.error) player.load();
          await player.play();
        } catch {
          feedback.textContent =
            "Audio could not play. Check your connection and tap Play to retry.";
          update();
        }
      });
      seek.addEventListener("input", () => {
        try {
          player.currentTime = Number(seek.value);
          update();
        } catch {
          feedback.textContent =
            "Seeking is not available yet. Try again once the audio has loaded.";
        }
      });
      for (const event of [
        "loadedmetadata",
        "durationchange",
        "timeupdate",
        "play",
        "pause",
        "ended",
        "seeked",
      ])
        player.addEventListener(event, update);
      root.dispose = () => {
        disposed = true;
        controller.abort();
        player.pause();
      };
      update();
      // Decode a bounded copy without starting an AudioContext or requesting a microphone.
      (async () => {
        try {
          const Context =
            window.OfflineAudioContext || window.webkitOfflineAudioContext;
          if (!Context) throw Error("Audio decoding unavailable");
          const response = await fetch(player.src, {
            signal: controller.signal,
          });
          if (!response.ok) throw Error("Audio unavailable");
          const declared = Number(response.headers.get("content-length"));
          if (declared > 8 * 1024 * 1024) throw Error("Audio too large");
          const bytes = await response.arrayBuffer();
          if (bytes.byteLength > 8 * 1024 * 1024)
            throw Error("Audio too large");
          const context = new Context(1, 1, 44100),
            buffer = await context.decodeAudioData(bytes);
          if (disposed) return;
          if (buffer.duration > 60.5) throw Error("Audio too long");
          decodedDuration = buffer.duration;
          const channels = Array.from(
              { length: buffer.numberOfChannels },
              (_, i) => buffer.getChannelData(i),
            ),
            values = [];
          const length = buffer.length;
          for (let i = 0; i < 48; i++) {
            const start = Math.floor((i * length) / 48),
              end = Math.max(start + 1, Math.floor(((i + 1) * length) / 48));
            let sum = 0;
            for (const channel of channels)
              for (let j = start; j < end; j++) sum += channel[j] * channel[j];
            values.push(Math.sqrt(sum / ((end - start) * channels.length)));
          }
          const peak = Math.max(...values, 0.00001);
          values.forEach((value, i) => {
            bars[i].style.height =
              Math.max(3, Math.round((value / peak) * 38)) + "px";
          });
          wave.dataset.ready = "true";
          update();
        } catch (error) {
          if (!disposed && error.name !== "AbortError") {
            wave.dataset.ready = "unavailable";
            feedback.textContent =
              "Waveform preview unavailable. You can still play the audio.";
          }
        }
      })();
      return root;
    },
  };
})();
