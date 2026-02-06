import {
  __esm
} from "./chunk-J7LXIPZS.mjs";

// src/utils/human-id.ts
function randomSuffix() {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  let result = "";
  for (let i = 0; i < 4; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}
function generateHumanId() {
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const suffix = randomSuffix();
  return `${adj}-${noun}-${suffix}`;
}
function generateShortHumanId() {
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${adj}-${noun}`;
}
var adjectives, nouns;
var init_human_id = __esm({
  "src/utils/human-id.ts"() {
    "use strict";
    adjectives = [
      "bold",
      "calm",
      "cool",
      "dark",
      "fast",
      "gold",
      "green",
      "happy",
      "kind",
      "loud",
      "mild",
      "neat",
      "nice",
      "pink",
      "pure",
      "quick",
      "rare",
      "rich",
      "safe",
      "slim",
      "soft",
      "tall",
      "tidy",
      "tiny",
      "warm",
      "wise",
      "young",
      "able",
      "blue",
      "brave",
      "busy",
      "clean",
      "crisp",
      "eager",
      "fair",
      "fresh",
      "glad",
      "grand",
      "keen",
      "lush",
      "prime",
      "proud",
      "sharp",
      "sleek",
      "smart",
      "solid",
      "swift",
      "vivid",
      "wild",
      "witty",
      "zesty"
    ];
    nouns = [
      "ant",
      "bat",
      "bear",
      "bee",
      "bird",
      "bull",
      "cat",
      "cow",
      "crab",
      "crow",
      "deer",
      "dog",
      "dove",
      "duck",
      "eagle",
      "elk",
      "fish",
      "fox",
      "frog",
      "goat",
      "hawk",
      "hare",
      "horse",
      "jay",
      "lark",
      "lion",
      "lynx",
      "mole",
      "moth",
      "mouse",
      "newt",
      "owl",
      "panda",
      "pig",
      "puma",
      "rat",
      "raven",
      "seal",
      "shark",
      "sheep",
      "sloth",
      "snail",
      "snake",
      "spider",
      "swan",
      "tiger",
      "toad",
      "trout",
      "viper",
      "wasp",
      "whale",
      "wolf",
      "wren",
      "yak",
      "zebra"
    ];
  }
});

export {
  generateHumanId,
  generateShortHumanId,
  init_human_id
};
//# sourceMappingURL=chunk-KFKHU6CM.mjs.map