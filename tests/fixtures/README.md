# Video import fixtures

These one-second, 160 × 90 H.264 colour-pattern clips are generated test media with no camera, audio or personal content. One uses MP4 and one QuickTime MOV. They exercise the existing-file picker independently of MediaRecorder output.

Generated with FFmpeg using the `testsrc2` source, libx264, yuv420p and no audio. The MOV remuxes the MP4 without transcoding. They are small enough to keep the browser checks reproducible without requiring FFmpeg at test time.
