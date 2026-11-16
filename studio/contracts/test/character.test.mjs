// The character and cast contract beyond its fixtures: what a production
// reads from a manifest once it holds.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  FORM_MEDIA, FORM_MEDIUM_DESCRIPTIONS, cannot, currentReleaseOf, defaultFormOf, parseCharacterRef, validateCast, validateCharacter,
} from "../src/character.mjs";

const valid = JSON.parse(readFileSync(new URL("../fixtures/character/valid.json", import.meta.url), "utf-8"));
const [puppet, sprites, paper, dot] = valid.characters;

test("every medium says what it is", () => {
  assert.deepEqual(Object.keys(FORM_MEDIUM_DESCRIPTIONS).sort(), [...FORM_MEDIA].sort());
  assert.ok(FORM_MEDIA.includes("other"));
});

test("a manifest that is not a mapping is one problem, not a throw", () => {
  for (const doc of [null, [], "berto", 3]) {
    assert.deepEqual(validateCharacter(doc).map((p) => p.code), ["type"]);
    assert.deepEqual(validateCast(doc).map((p) => p.code), ["type"]);
  }
});

test("a character on paper is valid: it has no form yet", () => {
  assert.deepEqual(validateCharacter(paper), []);
  assert.equal(defaultFormOf(paper), null);
});

test("the form a production wears when it names none", () => {
  assert.equal(defaultFormOf(puppet).id, "puppet");
  assert.equal(defaultFormOf(sprites).id, "pixels", "the default it names, of two");
  assert.equal(defaultFormOf(dot), null, "three forms and no default: the production must say");
  assert.equal(defaultFormOf({ ...dot, forms: [dot.forms[0]] }).id, "dot", "its only form");
});

test("a form's current release", () => {
  const [form] = puppet.forms;
  assert.equal(currentReleaseOf(form).id, "v003");
  assert.equal(currentReleaseOf({ ...form, current: undefined }), null, "two releases and none named current");
  assert.equal(currentReleaseOf(sprites.forms[0]).id, "v1", "its only release");
  assert.equal(currentReleaseOf(dot.forms[0]), null, "a form with nothing released");
});

test("a role's character is this owner's, or another's by its path", () => {
  assert.deepEqual(parseCharacterRef("sergeant"), { owner: null, id: "sergeant" });
  assert.deepEqual(parseCharacterRef("clinic/doctor"), { owner: ["clinic"], id: "doctor" });
  assert.deepEqual(parseCharacterRef("sketches/special/guide"), { owner: ["sketches", "special"], id: "guide" });
});

test("what a script asks for that a form cannot do", () => {
  const [form] = puppet.forms;
  assert.deepEqual(cannot(form, { actions: ["walk", "salute"], expressions: ["proud"] }), { actions: [], expressions: [], mouths: [], views: [] });
  assert.deepEqual(cannot(form, { actions: ["walk", "cartwheel"], expressions: ["furious"], views: ["back"] }), {
    actions: ["cartwheel"], expressions: ["furious"], mouths: [], views: ["back"],
  });
  assert.deepEqual(cannot({ id: "bare", medium: "voice" }, { actions: ["wave"] }).actions, ["wave"], "a form that lists nothing can do nothing that is asked by name");
});
