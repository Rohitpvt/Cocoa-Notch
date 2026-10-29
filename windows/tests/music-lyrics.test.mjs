// Tests for Music Playback, Synced Lyrics (LRC) & Mochi Beat Reaction
// Tests LRC parsing, timestamp calculation, active line tracking, and Mochi headphone dancing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLrc, getActiveLyricIndex } from "../src/core/lyrics.ts";
import { State } from "../src/core/state.ts";
import { BotEngine } from "../src/mochi/engine.ts";

test("LRC Parser: accurately parses timestamps, multi-timestamps, and trims lines", () => {
  const sampleLrc = `
[00:12.50] First verse of the song
[00:15.00][00:45.00] Repeated chorus line
[01:02.123] Precision milliseconds line
[invalid] Not a lyric line
[01:30] Standard minutes and seconds without millis
`;

  const lines = parseLrc(sampleLrc);

  assert.equal(lines.length, 5, "Should have parsed 5 timestamped lines (including repeated chorus)");

  // Verify sorted order
  for (let i = 1; i < lines.length; i++) {
    assert.ok(lines[i].timeSecs >= lines[i - 1].timeSecs, "Lines must be sorted by timeSecs ascending");
  }

  // Check individual items
  assert.equal(lines[0].timeSecs, 12.5);
  assert.equal(lines[0].text, "First verse of the song");

  assert.equal(lines[1].timeSecs, 15.0);
  assert.equal(lines[1].text, "Repeated chorus line");

  assert.equal(lines[2].timeSecs, 45.0);
  assert.equal(lines[2].text, "Repeated chorus line");

  assert.equal(lines[3].timeSecs, 62.123);
  assert.equal(lines[3].text, "Precision milliseconds line");

  assert.equal(lines[4].timeSecs, 90.0);
  assert.equal(lines[4].text, "Standard minutes and seconds without millis");
});

test("LRC Parser: handles empty, null, or malformed lyrics gracefully", () => {
  assert.deepEqual(parseLrc(""), []);
  assert.deepEqual(parseLrc(null), []);
  assert.deepEqual(parseLrc("Just plain text with no timestamp"), []);
});

test("getActiveLyricIndex: returns correct line index matching playback time", () => {
  const lines = [
    { timeSecs: 10.0, text: "Line 1" },
    { timeSecs: 20.0, text: "Line 2" },
    { timeSecs: 30.0, text: "Line 3" },
    { timeSecs: 40.0, text: "Line 4" },
  ];

  // Before first line
  assert.equal(getActiveLyricIndex(lines, 0.0), -1);
  assert.equal(getActiveLyricIndex(lines, 9.5), -1);

  // Exactly at line 1
  assert.equal(getActiveLyricIndex(lines, 10.0), 0);
  assert.equal(getActiveLyricIndex(lines, 15.0), 0);

  // Transition to line 2
  assert.equal(getActiveLyricIndex(lines, 20.0), 1);
  assert.equal(getActiveLyricIndex(lines, 25.0), 1);

  // Transition to line 3
  assert.equal(getActiveLyricIndex(lines, 30.0), 2);

  // Beyond last line
  assert.equal(getActiveLyricIndex(lines, 55.0), 3);
});

test("BotEngine headphones: wearing headphones and dancing to music", () => {
  const engine = new BotEngine();
  assert.equal(engine.hasHeadphones, false);
  assert.equal(engine.headphonesPresence, 0);

  // When dancing starts with headphones
  engine.setDancing(true, 128, true);
  assert.equal(engine.isDancing, true);
  assert.equal(engine.hasHeadphones, true);

  // Simulate update frame
  engine.update(0.1);
  assert.ok(engine.headphonesPresence > 0, "Headphones presence should start ramping up");

  // Advance time to full presence
  engine.update(0.3);
  assert.equal(engine.headphonesPresence, 1, "Headphones should be fully worn");

  // When music stops
  engine.setDancing(false);
  assert.equal(engine.isDancing, false);
  assert.equal(engine.hasHeadphones, false);

  // Presence ramps down
  engine.update(0.2);
  assert.ok(engine.headphonesPresence < 1, "Headphones presence should ramp down");
  engine.update(0.3);
  assert.equal(engine.headphonesPresence, 0, "Headphones should be completely removed");
});

test("State handles extended MusicPlaybackState with timeline and appName", () => {
  State.setMusicPlayback({
    isPlaying: true,
    title: "Blinding Lights",
    artist: "The Weeknd",
    albumTitle: "After Hours",
    albumColor: "#1DB954",
    appName: "Spotify",
    positionSecs: 45.2,
    durationSecs: 200.0,
    bpm: 171,
  });

  const current = State.musicPlayback;
  assert.ok(current !== null);
  assert.equal(current.title, "Blinding Lights");
  assert.equal(current.artist, "The Weeknd");
  assert.equal(current.albumTitle, "After Hours");
  assert.equal(current.appName, "Spotify");
  assert.equal(current.positionSecs, 45.2);
  assert.equal(current.durationSecs, 200.0);
  assert.equal(current.bpm, 171);
});
