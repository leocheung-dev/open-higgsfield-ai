import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserPollDeadlineError,
  IMAGE_POLL_DEADLINE_MS,
  VIDEO_POLL_DEADLINE_MS,
  isBrowserPollDeadlineError,
  pollDeadlineFor,
} from "./poll";

test("uses longer, surface-aware browser polling windows", () => {
  assert.equal(pollDeadlineFor("image"), IMAGE_POLL_DEADLINE_MS);
  assert.equal(pollDeadlineFor("video"), VIDEO_POLL_DEADLINE_MS);
  assert.ok(VIDEO_POLL_DEADLINE_MS > IMAGE_POLL_DEADLINE_MS);
});

test("accepts valid public polling configuration and rejects unsafe short values", () => {
  assert.equal(pollDeadlineFor("image", "45000"), 45000);
  assert.equal(pollDeadlineFor("video", "29999"), VIDEO_POLL_DEADLINE_MS);
  assert.equal(pollDeadlineFor("image", "not-a-number"), IMAGE_POLL_DEADLINE_MS);
});

test("labels a local polling deadline without implying a provider terminal state", () => {
  const error = new BrowserPollDeadlineError();
  assert.equal(isBrowserPollDeadlineError(error), true);
  assert.match(error.message, /local polling window/i);
  assert.doesNotMatch(error.message, /cancel|success|completed/i);
});
