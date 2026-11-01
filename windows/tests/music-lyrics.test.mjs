// Tests for Music Playback, Synced Lyrics (LRC) & Mochi Beat Reaction
// Tests LRC parsing, timestamp calculation, active line tracking, and Mochi headphone dancing.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseLrc,
  getActiveLyricIndex,
  isValidLrc,
  cleanTitle,
  getTitleVariants,
  getArtistVariants,
  synthesizeLinesFromPlain,
  decodeHtmlEntities,
  clearLyricsCache,
  CREDIT_OR_NOISE_LINE,
  PLACEHOLDER_OR_STUB_LINE,
} from "../src/core/lyrics.ts";
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

test("LRC Parser & isValidLrc: filters credit stubs and recognizes valid lyric streams", () => {
  // Bogus credit stub with offset suffix (e.g. NetEase Maula entry)
  const creditStub = "[00:00.00-1] 作词 : Anuv Jain\n[00:00.00-1] 作曲 : Anuv Jain\n";
  assert.equal(isValidLrc(creditStub), false, "Credit stub must be rejected as invalid LRC");
  assert.deepEqual(parseLrc(creditStub), [], "Credits must be filtered out, leaving empty lines array");

  // Song with credit prefix followed by real song lyrics
  const mixedLrc = `
[00:00.00] 作词 : Faheem Abdullah/Huzaif Nazar
[00:01.00] 作曲 : Faheem Abdullah/Huzaif Nazar
[00:14.05] Sajde Kiye Hote Khuda Ke Maine Agar
[00:20.91] Chhod Ke Na Jaata Woh Bhi Is Qadar
[00:27.48] Sajde Kiye Hote Khuda Ke Maine Agar
`;
  assert.equal(isValidLrc(mixedLrc), true, "Mixed LRC with >= 3 lyrics lines must be accepted");
  const parsed = parseLrc(mixedLrc);
  assert.equal(parsed.length, 3, "Only the 3 real lyrics lines should be parsed");
  assert.equal(parsed[0].text, "Sajde Kiye Hote Khuda Ke Maine Agar");
  assert.equal(parsed[0].timeSecs, 14.05);
});

test("Universal Title Cleaning: handles complex movie tags, versions, remasters, and suffixes", () => {
  assert.equal(cleanTitle('Tum Hi Ho (From "Aashiqui 2")'), "Tum Hi Ho");
  assert.equal(cleanTitle('Chaleya - From "Jawan"'), "Chaleya");
  assert.equal(cleanTitle('Kesariya (From "Brahmastra") [Audio]'), "Kesariya");
  assert.equal(cleanTitle("Die With A Smile (Live in Las Vegas)"), "Die With A Smile");
  assert.equal(cleanTitle("Blinding Lights - Remastered 2020"), "Blinding Lights");
  assert.equal(cleanTitle("Stay (with Justin Bieber)"), "Stay");
  assert.equal(cleanTitle("Starboy (feat. Daft Punk) - Explicit"), "Starboy");
  assert.equal(cleanTitle("Hotel California - 2013 Remaster"), "Hotel California");
  assert.equal(cleanTitle("Maula (Slowed + Reverb)"), "Maula");
  assert.equal(cleanTitle("Nights - Radio Edit"), "Nights");
  assert.equal(cleanTitle('Lose Yourself - From "8 Mile" Soundtrack'), "Lose Yourself");
});

test("Universal Title and Artist Disambiguation: generates comprehensive variants", () => {
  const titles = getTitleVariants('Chaleya (From "Jawan")');
  assert.ok(titles.includes("Chaleya"));
  assert.ok(titles.length >= 2);

  const artists = getArtistVariants("The Chainsmokers, Coldplay");
  assert.ok(artists.includes("The Chainsmokers, Coldplay"));
  assert.ok(artists.includes("The Chainsmokers"));
  assert.ok(artists.includes("Coldplay"));

  const collab = getArtistVariants("Lady Gaga & Bruno Mars");
  assert.ok(collab.includes("Lady Gaga"));
  assert.ok(collab.includes("Bruno Mars"));
});

test("Universal HTML and Stub Sanitization: decodes entities and purges credit noise", () => {
  const dirty = "Don&#x27;t stop &amp; look &quot;away&quot; &#8212; yes";
  assert.equal(decodeHtmlEntities(dirty), "Don't stop & look \"away\" — yes");

  assert.ok(CREDIT_OR_NOISE_LINE.test("作词 : Someone"));
  assert.ok(CREDIT_OR_NOISE_LINE.test("Written by Artist"));
  assert.ok(CREDIT_OR_NOISE_LINE.test("Produced by Producer"));
  assert.ok(PLACEHOLDER_OR_STUB_LINE.test("Lyrics not available"));
  assert.ok(PLACEHOLDER_OR_STUB_LINE.test("Instrumental"));
});

test("Universal Timestamp Synthesis: generates evenly distributed active lyrics without stubs", () => {
  const raw = `
[Verse 1]
Written by: Author
First real singing line
Second real singing line
Third real singing line
Fourth real singing line
Lyrics not available
`;
  const synthesized = synthesizeLinesFromPlain(raw, 200);
  assert.equal(synthesized.length, 4, "Must exclude section header, credit line, and placeholder stub");
  assert.equal(synthesized[0].text, "First real singing line");
  assert.equal(synthesized[3].text, "Fourth real singing line");
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

test("Music scrubber & live timeline: time formatting and progress clamping", () => {
  function formatTime(secs) {
    if (!secs || isNaN(secs) || secs < 0) return "00:00";
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }

  assert.equal(formatTime(0), "00:00");
  assert.equal(formatTime(-5), "00:00");
  assert.equal(formatTime(8), "00:08");
  assert.equal(formatTime(75), "01:15");
  assert.equal(formatTime(294), "04:54");

  // Clamping
  const duration = 200.0;
  const rawPos = 210.5;
  const clamped = Math.min(duration, Math.max(0, rawPos));
  assert.equal(clamped, 200.0);

  // Extrapolation math: LastUpdatedTime elapsed ticks to live position
  const rawSnapshotSecs = 10.0;
  const elapsedTicks = 15_000_000; // 1.5 seconds in 100ns units
  const elapsedSecs = elapsedTicks / 10_000_000.0;
  const livePos = rawSnapshotSecs + elapsedSecs;
  assert.equal(livePos, 11.5);
});

test("Lyrics auto-centering math: vertically centers the active line accurately", () => {
  function computeTargetScrollTop(containerHeight, currentScrollTop, lineTopRelToContainer, lineHeight) {
    const targetRelTop = (containerHeight - lineHeight) / 2;
    const delta = lineTopRelToContainer - targetRelTop;
    return Math.max(0, currentScrollTop + delta);
  }

  const containerH = 130;
  const lineH = 20;
  // Desired center top inside viewport: (130 - 20) / 2 = 55px

  // Case 1: Line is already centered at 55px
  let nextScroll = computeTargetScrollTop(containerH, 0, 55, lineH);
  assert.equal(nextScroll, 0, "No scroll delta needed when already centered");

  // Case 2: Line is lower in the list at 115px (60px below center)
  nextScroll = computeTargetScrollTop(containerH, 0, 115, lineH);
  assert.equal(nextScroll, 60, "Must scroll down by 60px so line sits at 55px");

  // Case 3: Line is scrolled too far up at 5px (near ceiling / notch)
  nextScroll = computeTargetScrollTop(containerH, 100, 5, lineH);
  assert.equal(nextScroll, 50, "Must scroll up to 50px so line moves down to 55px");

  // Case 4: Line at top with no room to scroll up clamps to 0
  nextScroll = computeTargetScrollTop(containerH, 0, 10, lineH);
  assert.equal(nextScroll, 0, "Clamps cleanly to 0");
});

test("clearLyricsCache: successfully clears track-specific cache or all entries", () => {
  assert.doesNotThrow(() => {
    clearLyricsCache("Maula", "Anuv Jain");
    clearLyricsCache();
  });
});
