import { expect, test } from "vitest";
import { renderWork } from "$lib/film-format";

test("a render says how many windows of picture it drew and how many it kept", () => {
  expect(renderWork({ pictureChunks: 3, pictureReused: 2, soundChunks: 2, soundReused: 0 })).toBe("picture: 1 of 3 windows rendered, 2 kept as they were");
  expect(renderWork({ pictureChunks: 3, pictureReused: 1 })).toBe("picture: 2 of 3 windows rendered, 1 kept as it was");
  expect(renderWork({ pictureChunks: 4, pictureReused: 0 })).toBe("picture: 4 of 4 windows rendered");
  expect(renderWork({ pictureChunks: 1, pictureReused: 0 })).toBe("picture: 1 of 1 window rendered");
});

test("a render with no count, or a count that does not hold, says nothing of it", () => {
  for (const work of [null, undefined, {}, { pictureChunks: 0, pictureReused: 0 }, { pictureChunks: 2, pictureReused: 3 }, { pictureChunks: "3", pictureReused: 1.5 }]) {
    expect(renderWork(work)).toBe("");
  }
});
