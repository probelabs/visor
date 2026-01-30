/**
 * Generate human-readable IDs like Kubernetes (e.g., "happy-panda-7x3k")
 */

const adjectives = [
  'bold',
  'calm',
  'cool',
  'dark',
  'fast',
  'gold',
  'green',
  'happy',
  'kind',
  'loud',
  'mild',
  'neat',
  'nice',
  'pink',
  'pure',
  'quick',
  'rare',
  'rich',
  'safe',
  'slim',
  'soft',
  'tall',
  'tidy',
  'tiny',
  'warm',
  'wise',
  'young',
  'able',
  'blue',
  'brave',
  'busy',
  'clean',
  'crisp',
  'eager',
  'fair',
  'fresh',
  'glad',
  'grand',
  'keen',
  'lush',
  'prime',
  'proud',
  'sharp',
  'sleek',
  'smart',
  'solid',
  'swift',
  'vivid',
  'wild',
  'witty',
  'zesty',
];

const nouns = [
  'ant',
  'bat',
  'bear',
  'bee',
  'bird',
  'bull',
  'cat',
  'cow',
  'crab',
  'crow',
  'deer',
  'dog',
  'dove',
  'duck',
  'eagle',
  'elk',
  'fish',
  'fox',
  'frog',
  'goat',
  'hawk',
  'hare',
  'horse',
  'jay',
  'lark',
  'lion',
  'lynx',
  'mole',
  'moth',
  'mouse',
  'newt',
  'owl',
  'panda',
  'pig',
  'puma',
  'rat',
  'raven',
  'seal',
  'shark',
  'sheep',
  'sloth',
  'snail',
  'snake',
  'spider',
  'swan',
  'tiger',
  'toad',
  'trout',
  'viper',
  'wasp',
  'whale',
  'wolf',
  'wren',
  'yak',
  'zebra',
];

/**
 * Generate a random alphanumeric suffix (4 chars)
 */
function randomSuffix(): string {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789'; // no i,l,o,0,1 to avoid confusion
  let result = '';
  for (let i = 0; i < 4; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

/**
 * Generate a human-readable ID like "happy-panda-7x3k"
 */
export function generateHumanId(): string {
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const suffix = randomSuffix();
  return `${adj}-${noun}-${suffix}`;
}

/**
 * Generate a short human-readable ID like "happy-panda" (no suffix)
 */
export function generateShortHumanId(): string {
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${adj}-${noun}`;
}
