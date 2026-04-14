import { add } from './add';

const tests = [
  { name: 'positive numbers', input: [1, 2], expected: 3 },
  { name: 'negative numbers', input: [-5, -3], expected: -8 },
  { name: 'positive and negative', input: [10, -4], expected: 6 },
  { name: 'floating point', input: [1.5, 2.5], expected: 4 },
  { name: 'large numbers', input: [999999, 1], expected: 1000000 },
];

let passed = 0;
let failed = 0;

for (const test of tests) {
  const result = add(test.input[0], test.input[1]);
  if (result === test.expected) {
    console.log(`✓ ${test.name}`);
    passed++;
  } else {
    console.log(`✗ ${test.name}: expected ${test.expected}, got ${result}`);
    failed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
